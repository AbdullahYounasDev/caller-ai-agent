import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * SIGNED SESSION TICKETS — how the browser is allowed to open a voice socket without
 * ever holding INTERNAL_API_KEY.
 *
 * The problem: every route is guarded by a shared secret the browser must never see
 * (lib/auth/internal.js), but a WebSocket from the test console cannot send that
 * header, and the gateway is a separate process on its own port. So the flow is:
 *
 *   1. browser → POST /api/voice/session (Next.js, internal-auth guarded, checks the
 *      tenant is serviceable — §4, §6.18) → gets a TICKET
 *   2. browser → gateway WebSocket, first message { ticket }
 *   3. gateway verifies the HMAC with the shared secret, checks expiry, and refuses a
 *      ticket it has already seen
 *
 * A ticket names ONE tenant and ONE of its agents (signed, so the browser cannot swap the
 * agent after the route checked it — CLAUDE.md §6.27), lives LIMITS.sessionTicketTtlMs (a minute — it only has
 * to survive the round trip to the socket), and is single-use. It is not a login and
 * grants nothing beyond opening one call for that tenant.
 *
 * NOT the removed widget's conversation tokens (§2): those were long-lived public
 * credentials for an embeddable channel. This is a one-minute internal hand-off between
 * two of our own processes. A phone call uses the same hand-off, but its trust comes from
 * a verified Twilio signature on the webhook (telephony/twilio-signature.js): the webhook
 * issues the ticket and Twilio hands it, as a stream parameter, to the gateway (§6.24).
 */

const DEV_SECRET = "dev-only-voice-ticket-secret-never-used-in-production";
let warnedDev = false;

/**
 * The HMAC secret, shared by the Next.js process (signs) and the gateway (verifies).
 * VOICE_SESSION_SECRET if set, else INTERNAL_API_KEY. With neither: a fixed dev secret
 * outside production (with a warning, mirroring lib/auth/internal.js), and NULL in
 * production — which makes both sides refuse every session. Fail closed.
 *
 * @returns {string|null}
 */
export function ticketSecret(env = process.env) {
  const secret = env.VOICE_SESSION_SECRET || env.INTERNAL_API_KEY;
  if (secret) return secret;
  if (env.NODE_ENV === "production") return null;
  if (!warnedDev) {
    warnedDev = true;
    console.warn("[voice] VOICE_SESSION_SECRET / INTERNAL_API_KEY not set — using a dev-only ticket secret.");
  }
  return DEV_SECRET;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string|null} [args.agentId]  null = the tenant's default agent
 * @param {{numberId: string, toNumber: string, fromNumber?: string|null}|null} [args.line] the number the call is
 *   "dialled" on (§6.29) and, on a phone call, who is calling — signed too, so neither can be forged
 * @param {{conversationId: string, callId?: string|null, language?: string|null, count?: number}|null} [args.resume]
 *   this call is a CONTINUATION of one that was handed to people and came back unanswered (§6.30): the
 *   conversation to carry on, the call it continues, the language last spoken and how many times the
 *   call has already come back (the webhook stops it coming back for ever)
 * @param {number} args.ttlMs
 * @param {string} args.secret
 * @param {number} [args.now]
 * @returns {{ticket: string, expiresAt: number}}
 */
export function issueTicket({ tenantId, agentId = null, line = null, resume = null, ttlMs, secret, now = Date.now() }) {
  const expiresAt = now + ttlMs;
  const claims = { t: tenantId, a: agentId, e: expiresAt, n: randomBytes(12).toString("base64url") };
  if (line) Object.assign(claims, { l: line.numberId, d: line.toNumber, ...(line.fromNumber ? { f: line.fromNumber } : {}) });
  if (resume?.conversationId) {
    Object.assign(claims, {
      rc: resume.conversationId,
      ...(resume.callId ? { rk: resume.callId } : {}),
      ...(resume.language ? { rg: resume.language } : {}),
      rn: Math.max(1, Math.trunc(resume.count ?? 1)),
    });
  }
  const payload = b64url(JSON.stringify(claims));
  return { ticket: `${payload}.${sign(payload, secret)}`, expiresAt };
}

/**
 * A verifier that also remembers which tickets it has accepted, until they expire —
 * a ticket is good for exactly one socket.
 *
 * @param {object} args
 * @param {string} args.secret
 * @param {() => number} [args.now]
 */
export function createTicketVerifier({ secret, now = () => Date.now() }) {
  const used = new Map(); // nonce -> expiresAt

  return {
    /**
     * @param {string} ticket
     * @returns {{ok: true, tenantId: string, agentId: string|null, line: {numberId: string, toNumber: string, fromNumber: string|null}|null, resume: {conversationId: string, callId: string|null, language: string|null, count: number}|null} | {ok: false, reason: "malformed"|"signature"|"expired"|"replayed"}}
     */
    verify(ticket) {
      const at = now();
      for (const [nonce, exp] of used) if (exp < at) used.delete(nonce);

      const [payload, signature, extra] = String(ticket ?? "").split(".");
      if (!payload || !signature || extra !== undefined) return { ok: false, reason: "malformed" };

      const expected = Buffer.from(sign(payload, secret));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        return { ok: false, reason: "signature" };
      }

      let claims;
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return { ok: false, reason: "malformed" };
      }
      if (
        typeof claims?.t !== "string" || typeof claims?.e !== "number" || typeof claims?.n !== "string" ||
        (claims.a != null && typeof claims.a !== "string") ||
        (claims.l != null && (typeof claims.l !== "string" || typeof claims.d !== "string")) ||
        (claims.f != null && typeof claims.f !== "string") ||
        (claims.rc != null && (typeof claims.rc !== "string" || (claims.rk != null && typeof claims.rk !== "string") || (claims.rg != null && typeof claims.rg !== "string") || typeof claims.rn !== "number"))
      ) {
        return { ok: false, reason: "malformed" };
      }
      if (claims.e < at) return { ok: false, reason: "expired" };
      if (used.has(claims.n)) return { ok: false, reason: "replayed" };

      used.set(claims.n, claims.e);
      return { ok: true, tenantId: claims.t, agentId: claims.a ?? null, line: claims.l ? { numberId: claims.l, toNumber: claims.d, fromNumber: claims.f ?? null } : null,
        resume: claims.rc ? { conversationId: claims.rc, callId: claims.rk ?? null, language: claims.rg ?? null, count: claims.rn } : null };
    },
  };
}
