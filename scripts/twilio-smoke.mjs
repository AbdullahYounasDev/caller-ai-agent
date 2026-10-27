#!/usr/bin/env node
/**
 * A PHONE CALL WITHOUT A PHONE — plays Twilio's part against the REAL app and the REAL voice gateway
 * (CLAUDE.md §6.30):
 *
 *   npm run dev    (the app, with the TWILIO_* variables set — see .env.example)
 *   npm run voice  (the gateway)
 *   npm run twilio:smoke [-- --say="What are your opening hours?"]
 *
 *   1. makes a business, an agent and a phone number in the database (and removes them at the end)
 *   2. posts what Twilio posts when a call comes in — SIGNED with TWILIO_AUTH_TOKEN — to the real
 *      webhook, and shows that an unsigned or wrongly signed request and an unknown number are refused
 *   3. opens the Media Stream the answer's TwiML asks for, sends the start message, then speaks a
 *      question as 8 kHz μ-law, 20 ms at a time, in real time — exactly what Twilio sends
 *   4. reports what came back (the agent's voice as μ-law frames), and reads the call's record from
 *      the database: transport, numbers, what the agent HEARD, what it answered
 *
 * What it does NOT prove: Twilio's own network, the carrier audio quality, or the transfer's REST call
 * (that needs a real Twilio account). It spends one chat request and one embedding only when a model
 * key is configured; without one the turn fails and the agent says its apology — the transport is
 * proven either way.
 */
process.loadEnvFile?.(".env");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, "").split("=");
  return [k, v.length ? v.join("=") : true];
}));

const appUrl = process.env.APP_URL || "http://localhost:3000";
const token = process.env.TWILIO_AUTH_TOKEN;
const base = (process.env.TWILIO_WEBHOOK_BASE_URL || process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
if (!token || !base) {
  console.error("Set TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_BASE_URL (or PUBLIC_APP_URL) — the app must have the same values.");
  process.exit(2);
}

const { prisma } = await import("@/lib/db");
const { saveAgentConfig, invalidateAgentConfig } = await import("@/lib/tenant/config");
const { addNumber } = await import("@/lib/standins/numbers");
const { twilioSignature } = await import("@/lib/telephony/twilio-signature");
const { float32ToMulaw, mulawToFloat32, resample } = await import("@/lib/voice/audio");
const { loadLocalSpeech } = await import("@/lib/voice/speech/engine");
const { createTextToSpeech } = await import("@/lib/voice/speech/tts");
const { WebSocket } = await import("ws");

const TENANT = "__twilio_smoke__";
const NUMBER = "+442079460000";
const FROM = "+923001234567";
const CALL_SID = `CA${"d".repeat(32)}`;
const say = args.say || "What are your opening hours?";
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const t0 = performance.now();
const log = (...a) => console.log(`+${((performance.now() - t0) / 1000).toFixed(2)}s`, ...a);
let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${message}`);
  if (!ok) failures++;
};

async function cleanup() {
  await prisma.callLog.deleteMany({ where: { tenantId: TENANT } });
  await prisma.message.deleteMany({ where: { tenantId: TENANT } });
  await prisma.conversation.deleteMany({ where: { tenantId: TENANT } });
  await prisma.phoneNumber.deleteMany({ where: { tenantId: TENANT } });
  await prisma.agentConfig.deleteMany({ where: { tenantId: TENANT } });
  invalidateAgentConfig(TENANT);
}

/** What Twilio sends: a form POST, signed over the URL it was configured with. */
async function postWebhook(path, params, { signature } = {}) {
  const signed = signature ?? twilioSignature({ authToken: token, url: `${base}${path}`, params });
  return fetch(`${appUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signed },
    body: new URLSearchParams(params).toString(),
  });
}

try {
  await cleanup();
  await saveAgentConfig(TENANT, { businessName: "Phone Smoke Clinic", purpose: "A clinic used to test the phone path.", timezone: "Asia/Karachi", replyLanguage: "en" });
  const agentId = (await prisma.agentConfig.findFirst({ where: { tenantId: TENANT } })).id;
  await addNumber(TENANT, { e164: NUMBER, agentId, label: "smoke" });
  log(`business ready; ${NUMBER} rings its agent`);

  // ── the webhook ──────────────────────────────────────────────────────────
  const path = "/api/telephony/twilio/voice";
  const params = { To: NUMBER, From: FROM, CallSid: CALL_SID, CallStatus: "ringing" };
  check((await postWebhook(path, params, { signature: "AAAA" })).status === 403, "a request with a wrong signature is refused (403)");
  check((await fetch(`${appUrl}${path}`, { method: "POST", body: new URLSearchParams(params) })).status === 403, "a request with no signature is refused (403)");
  const unknown = await (await postWebhook(path, { ...params, To: "+442079469999" })).text();
  check(/not in service/.test(unknown) && !unknown.includes("<Connect>"), "a number nobody owns hears 'not in service' and is hung up on");

  const answered = await postWebhook(path, params);
  const twiml = await answered.text();
  check(answered.status === 200 && /<Connect><Stream url="/.test(twiml), "a verified call to a real number is answered with a media stream");
  const streamUrl = /<Stream url="([^"]+)"/.exec(twiml)?.[1];
  const ticket = /name="ticket" value="([^"]+)"/.exec(twiml)?.[1];
  if (!streamUrl || !ticket) throw new Error(`no stream in the answer:\n${twiml}`);
  // The stream's address as Twilio would use it; here it is the local gateway.
  const url = streamUrl.replace(/^wss?:\/\/[^/]+/, `ws://localhost:${process.env.VOICE_GATEWAY_PORT || 3001}`);

  // ── the caller's voice, as Twilio would send it ───────────────────────────
  const engine = await loadLocalSpeech();
  const tts = createTextToSpeech({ engine });
  const question = await tts.synthesize({ text: say, language: "en" });
  const phoneQuestion = float32ToMulaw(resample(question.samples, question.sampleRate, 8_000));
  log(`caller will say: "${say}" (${(phoneQuestion.length / 8000).toFixed(1)} s of 8 kHz μ-law)`);

  const ws = new WebSocket(url);
  const outbound = [];
  let lastFrameAt = null;
  let marked = false;
  ws.on("message", (data) => {
    const m = JSON.parse(String(data));
    if (m.event === "media") {
      outbound.push(Buffer.from(m.media.payload, "base64"));
      lastFrameAt = performance.now();
    }
  });
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise((resolve, reject) => (ws.on("open", resolve), ws.on("error", reject)));
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({ event: "start", start: { streamSid: "MZsmoke", callSid: CALL_SID, accountSid: "ACsmoke", tracks: ["inbound"], customParameters: { ticket }, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } }));

  // The greeting arrives as frames; wait until it has stopped coming, then wait for it to "play".
  const startWait = performance.now();
  while (!outbound.length && performance.now() - startWait < 20_000) await sleep(100);
  check(outbound.length > 0, "the agent greets the caller (μ-law frames arrive)");
  while (lastFrameAt && performance.now() - lastFrameAt < 1_500) await sleep(100);
  const greetingBytes = outbound.reduce((n, b) => n + b.length, 0);
  check(outbound.every((b) => b.length <= 160), "every outbound frame is at most 20 ms (160 bytes)");
  log(`greeting: ${(greetingBytes / 8000).toFixed(1)} s of audio`);
  await sleep((greetingBytes / 8000) * 1000 + 300); // the greeting "plays"; the gateway uses its own estimate

  // speak, 20 ms per frame in real time, then a second of silence to end the turn
  // A person breathes in before they speak: 400 ms of line noise first. (Speech starting at the very
  // first sample is not what a phone call sounds like, and the VAD then misses the first word.)
  const silence = Buffer.alloc(8000, 0xff);
  const speech = Buffer.concat([Buffer.alloc(3200, 0xff), phoneQuestion, silence]);
  const before = outbound.length;
  for (let i = 0, next = performance.now(); i < speech.length; i += 160) {
    ws.send(JSON.stringify({ event: "media", media: { track: "inbound", chunk: String(i / 160 + 1), timestamp: String(i / 8), payload: speech.subarray(i, i + 160).toString("base64") } }));
    next += 20;
    await sleep(Math.max(0, next - performance.now()));
  }
  // wait for the reply (or the apology, with no model key) to arrive and settle
  const replyWait = performance.now();
  while (outbound.length === before && performance.now() - replyWait < 30_000) await sleep(100);
  while (lastFrameAt && performance.now() - lastFrameAt < 1_500) await sleep(100);
  const replyBytes = outbound.slice(before).reduce((n, b) => n + b.length, 0);
  check(replyBytes > 0, "the agent answers out loud after the question");
  log(`reply: ${(replyBytes / 8000).toFixed(1)} s of audio`);

  ws.send(JSON.stringify({ event: "stop", streamSid: "MZsmoke" }));
  await Promise.race([closed, sleep(10_000)]);
  await sleep(1_500); // the record is written just after the end

  // ── what the database kept ───────────────────────────────────────────────
  const call = await prisma.callLog.findFirst({ where: { tenantId: TENANT }, orderBy: { createdAt: "desc" }, include: { turns: { orderBy: { index: "asc" } }, events: { orderBy: { seq: "asc" } } } });
  check(call?.transport === "twilio", "the call is recorded as a phone call (transport twilio)");
  check(call?.toNumber === NUMBER && call?.fromNumber === FROM, "…with the number dialled and the number that called");
  check(call?.phoneNumberId != null, "…linked to the phone number's record");
  check(call?.events.some((e) => e.type === "twilio.stream" && e.data?.callSid === CALL_SID), "…and the Twilio call id is on the timeline");
  check(["caller_hangup", "disconnected"].includes(call?.endReason ?? ""), `the call ended cleanly when the stream stopped (${call?.endReason})`);
  const turn = call?.turns?.[0];
  console.log(`\nthe agent HEARD:    "${turn?.callerText ?? "(no turn)"}"   (asked: "${say}")`);
  console.log(`the agent ANSWERED: "${(turn?.agentText ?? "").slice(0, 200)}"`);
  console.log(`outcome: ${turn?.outcome ?? "-"} · intent: ${turn?.intent ?? "-"}${turn?.error ? ` · error: ${String(turn.error).slice(0, 120)}` : ""}`);
  check(Boolean(turn?.callerText), "the caller's 8 kHz phone audio was understood as words");
} catch (err) {
  console.error("smoke failed:", err);
  failures++;
} finally {
  await cleanup().catch(() => {});
  await prisma.$disconnect();
}
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
