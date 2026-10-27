import { voiceLine } from "@/lib/agent/prompt";
import { LIMITS } from "@/lib/voice/config";
import { issueTicket, ticketSecret } from "@/lib/voice/ticket";
import { toE164 } from "./routing";
import { signToken, verifyToken } from "./signed-token";
import { connectStream, dialNumber, hangup, sayAndHangup, sayOnly } from "./twiml";
import { twilioConfig, WEBHOOK_PATHS } from "./twilio-config";

/**
 * WHAT OUR TWILIO WEBHOOKS DO, apart from HTTP (CLAUDE.md §6.30). The Next.js routes under
 * /api/telephony/twilio only read the request, check Twilio's signature and call these; everything
 * decided here is plain functions over plain values, so the whole call-answering logic is tested
 * (tests/twilio-telephony.test.mjs) without Twilio, a server or a database.
 *
 *   answerInboundCall    a call came in on a number: who answers? → a stream to the gateway, or a polite refusal
 *   buildTransferTwiml   ring the people the agent is passing the caller to, one after another
 *   continueTransfer     that person did not pick up: ring the next, or bring the call back to the agent
 *   whisperTwiml         what the person who picks up hears first: why the call is for them
 *
 * Every answer is a 200 with TwiML — even an internal error — because a non-2xx makes Twilio say its
 * own "application error" to the caller; a short, true sentence from us is better.
 */

/** What a caller hears when nobody can answer on a number (voiceLine "not_in_service"). */
const NOT_IN_SERVICE = voiceLine("not_in_service", "en");
const BUSY = voiceLine("busy", "en");
const TROUBLE = "Sorry, we are having trouble taking your call right now. Please try again in a moment. Goodbye.";

/** How long one person's phone rings before the next is tried. */
export const TRANSFER_RING_SECONDS = 20;
/** The transfer's state in a URL is good for this long — a call does not wait longer than a few rings. */
const TRANSFER_TOKEN_TTL_MS = 10 * 60_000;
/** How many times one call may come back from an unanswered transfer: a caller who keeps asking for a
 *  person nobody answers is told so, and the call ends — it does not circle for ever. */
export const MAX_RESUMES = 2;
/** The summary said to the person who picks up. */
const WHISPER_MAX_CHARS = 400;
/** Calls one business may START per minute through the webhook. Twilio's signature already proves the
 *  request is real; this stops a captured, replayed one from opening calls without end. */
export const INBOUND_LIMIT = { limit: 120, windowMs: 60_000 };

/**
 * A call came in. `params` are Twilio's verified POST parameters.
 *
 * @param {object} args
 * @param {Record<string, string>} args.params
 * @param {Record<string, string|undefined>} [args.env]
 * @param {(dialled: string) => Promise<object>} args.resolve  registry.js resolveDialledNumber
 * @param {(key: string) => {ok: boolean}} [args.limit]        a per-business rate limit
 * @param {(tenantId: string) => Promise<{ok: boolean, reason?: string}>} [args.gateway]  can the voice gateway take
 *   this call now? (gateway-check.js) — a full or stopped gateway gets a spoken line instead of silence
 * @param {number} [args.now]
 * @returns {Promise<{xml: string, outcome: {result: "connected"|"refused"|"limited"|"misconfigured"|"busy"|"unavailable", reason?: string, tenantId?: string, agentId?: string|null, to?: string|null, callSid?: string|null}}>}
 */
export async function answerInboundCall({ params, env = process.env, resolve, limit = () => ({ ok: true }), gateway = async () => ({ ok: true }), now = Date.now() }) {
  const config = twilioConfig(env);
  const callSid = params.CallSid ?? null;
  const dialled = params.To ?? params.Called ?? "";

  const route = await resolve(dialled);
  if (!route.ok) return { xml: sayAndHangup(NOT_IN_SERVICE), outcome: { result: "refused", reason: route.reason, to: dialled, callSid } };

  if (!limit(`twilio:inbound:${route.tenantId}`).ok) {
    return { xml: sayAndHangup(TROUBLE), outcome: { result: "limited", tenantId: route.tenantId, to: route.e164, callSid } };
  }

  const secret = ticketSecret(env);
  if (!secret || !config.streamUrl) {
    return { xml: sayAndHangup(TROUBLE), outcome: { result: "misconfigured", reason: secret ? "VOICE_GATEWAY_PUBLIC_URL is not set" : "no ticket secret", tenantId: route.tenantId, to: route.e164, callSid } };
  }

  // Ask the gateway BEFORE handing the call over: a refusal after that is a silent close, and a caller
  // who hears nothing hangs up not knowing why. The gateway still enforces every limit itself.
  const room = await gateway(route.tenantId);
  if (!room.ok) {
    const busy = room.reason === "busy" || room.reason === "tenant_busy";
    return { xml: sayAndHangup(busy ? BUSY : TROUBLE), outcome: { result: busy ? "busy" : "unavailable", reason: room.reason, tenantId: route.tenantId, to: route.e164, callSid } };
  }

  // Who is calling: kept only when it is a real number ("anonymous" and SIP addresses are not).
  const from = toE164(params.From ?? params.Caller ?? "");
  const { ticket } = issueTicket({
    tenantId: route.tenantId,
    agentId: route.agentId,
    line: { numberId: route.numberId, toNumber: route.e164, fromNumber: from.ok ? from.value : null },
    ttlMs: LIMITS.sessionTicketTtlMs,
    secret,
    now,
  });
  return {
    xml: connectStream({ url: config.streamUrl, parameters: { ticket } }),
    outcome: { result: "connected", tenantId: route.tenantId, agentId: route.agentId, to: route.e164, callSid },
  };
}

/**
 * The TwiML that rings `contacts[index]`, and — through its `action` — what to do when that person
 * does not answer (the next one). The state travels in a signed token in the URLs, so Twilio can
 * call back to ANY server instance and nothing in memory has to survive.
 *
 * @param {object} args
 * @param {Array<{phone: string, role?: string, name?: string}>} args.contacts  in the order to try
 * @param {number} args.index
 * @param {string} [args.summary]  what the person who picks up is told first
 * @param {object} [args.resume]  where to bring the call back to if nobody answers (see resumeFromToken)
 * @param {{baseUrl: string}} args.config
 * @param {string} args.secret
 * @param {number} [args.now]
 * @returns {string|null} null when `index` is past the end
 */
export function buildTransferTwiml({ contacts, index, summary = "", resume = null, config, secret, now = Date.now() }) {
  const contact = contacts[index];
  if (!contact?.phone) return null;
  const token = signToken(
    "xfer",
    {
      p: contacts.map((c) => c.phone),
      i: index,
      s: String(summary).replace(/\s+/g, " ").trim().slice(0, WHISPER_MAX_CHARS),
      ...(resume?.conversationId ? { r: packResume(resume) } : {}),
    },
    { secret, ttlMs: TRANSFER_TOKEN_TTL_MS, now }
  );
  return dialNumber({
    number: contact.phone,
    timeoutSec: TRANSFER_RING_SECONDS,
    action: `${config.baseUrl}${WEBHOOK_PATHS.transfer}?t=${token}`,
    whisperUrl: `${config.baseUrl}${WEBHOOK_PATHS.whisper}?t=${token}`,
  });
}

/** The call's way back to the agent, short enough to travel in a URL (keys are the token's own). */
function packResume(resume) {
  return {
    t: resume.tenantId,
    a: resume.agentId ?? null,
    ...(resume.line?.numberId ? { l: resume.line.numberId, d: resume.line.toNumber, ...(resume.line.fromNumber ? { f: resume.line.fromNumber } : {}) } : {}),
    c: resume.conversationId,
    k: resume.callId ?? null,
    g: resume.language ?? null,
    n: Math.max(0, Math.trunc(resume.count ?? 0)),
  };
}

/**
 * The dial ended. Answered and finished → the call is over. Not answered → the next person. Nobody
 * left → the call goes BACK TO THE AGENT (a new media stream on the same Twilio call, carrying a
 * resume ticket: the conversation continues, the agent says nobody is available and can take a
 * call-back — CLAUDE.md §6.26/§6.30). It goes back only if the transfer was set up with a way back, the
 * gateway has room and the call has not already come back MAX_RESUMES times; otherwise the old
 * behaviour: a fixed line and goodbye.
 *
 * @param {object} args
 * @param {unknown} args.token        the signed state from the URL
 * @param {Record<string, string>} args.params  Twilio's verified parameters (DialCallStatus…)
 * @param {Record<string, string|undefined>} [args.env]
 * @param {(tenantId: string) => Promise<{ok: boolean}>} [args.gateway]  can the voice gateway take the call back? (gateway-check.js)
 * @param {number} [args.now]
 * @returns {Promise<{xml: string, outcome: {result: "finished"|"next"|"exhausted"|"resumed"|"invalid", status?: string, index?: number, reason?: string}}>}
 */
export async function continueTransfer({ token, params, env = process.env, gateway = async () => ({ ok: false }), now = Date.now() }) {
  const secret = ticketSecret(env);
  const state = secret ? verifyToken("xfer", token, { secret, now }) : null;
  if (!state || !Array.isArray(state.p)) return { xml: sayAndHangup(TROUBLE), outcome: { result: "invalid" } };

  const status = params.DialCallStatus ?? "";
  if (status === "completed" || status === "answered") return { xml: hangup(), outcome: { result: "finished", status } };

  const contacts = state.p.map((phone) => ({ phone }));
  const config = twilioConfig(env);
  const resume = state.r && typeof state.r === "object" ? state.r : null;
  const next = buildTransferTwiml({ contacts, index: Number(state.i) + 1, summary: state.s, resume: resume && unpackResume(resume), config, secret, now });
  if (next) return { xml: next, outcome: { result: "next", status, index: Number(state.i) + 1 } };

  const exhausted = { xml: sayAndHangup(voiceLine("transfer_unanswered", "en")), outcome: { result: "exhausted", status } };
  if (!resume || typeof resume.t !== "string" || typeof resume.c !== "string" || !config.streamUrl) return exhausted;
  const count = Number(resume.n) || 0;
  if (count >= MAX_RESUMES) return { ...exhausted, outcome: { ...exhausted.outcome, reason: "resume_limit" } };
  const room = await gateway(resume.t);
  if (!room.ok) return { ...exhausted, outcome: { ...exhausted.outcome, reason: `gateway_${room.reason ?? "unavailable"}` } };

  const { ticket } = issueTicket({
    tenantId: resume.t,
    agentId: resume.a ?? null,
    line: resume.l ? { numberId: resume.l, toNumber: resume.d, fromNumber: resume.f ?? null } : null,
    resume: { conversationId: resume.c, callId: resume.k ?? null, language: resume.g ?? null, count: count + 1 },
    ttlMs: LIMITS.sessionTicketTtlMs,
    secret,
    now,
  });
  return { xml: connectStream({ url: config.streamUrl, parameters: { ticket } }), outcome: { result: "resumed", status, index: Number(state.i) } };
}

/** The packed way back, as buildTransferTwiml takes it (so the NEXT person's token carries it too). */
function unpackResume(r) {
  return {
    tenantId: r.t,
    agentId: r.a ?? null,
    line: r.l ? { numberId: r.l, toNumber: r.d, fromNumber: r.f ?? null } : null,
    conversationId: r.c,
    callId: r.k ?? null,
    language: r.g ?? null,
    count: Number(r.n) || 0,
  };
}

/**
 * What the person who picks up hears before they are connected. English: it is read by Twilio's
 * own voice, which has no Urdu one.
 *
 * @param {unknown} token
 * @param {{env?: Record<string, string|undefined>, now?: number}} [options]
 * @returns {string} TwiML — silence (the call just connects) when the token is not valid
 */
export function whisperTwiml(token, { env = process.env, now = Date.now() } = {}) {
  const secret = ticketSecret(env);
  const state = secret ? verifyToken("xfer", token, { secret, now }) : null;
  const summary = typeof state?.s === "string" ? state.s.trim() : "";
  return sayOnly(summary ? `Incoming call from your AI assistant. ${summary}` : "Incoming call from your AI assistant.");
}
