import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { twilioSignature, verifyTwilioSignature } from "@/lib/telephony/twilio-signature";
import { signToken, verifyToken } from "@/lib/telephony/signed-token";
import { connectStream, dialNumber, hangup, sayAndHangup, sayOnly } from "@/lib/telephony/twiml";
import { describeTwilioSetup, twilioConfig } from "@/lib/telephony/twilio-config";
import { redirectCall } from "@/lib/telephony/twilio-rest";
import { answerInboundCall, buildTransferTwiml, continueTransfer, whisperTwiml, INBOUND_LIMIT } from "@/lib/telephony/twilio-webhook";
import { readVerifiedTwilioRequest } from "@/lib/telephony/twilio-request";
import { createTicketVerifier } from "@/lib/voice/ticket";

// The phone path's server half (CLAUDE.md §6.30): who may call our webhooks, what they answer, and how a
// transfer is carried — no Twilio, no server, no database.

const ENV = {
  TWILIO_AUTH_TOKEN: "auth-token-for-tests",
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_WEBHOOK_BASE_URL: "https://engine.example.com/",
  VOICE_GATEWAY_PUBLIC_URL: "https://voice.example.com",
  VOICE_SESSION_SECRET: "shared-test-secret",
};
const CALL_SID = `CA${"b".repeat(32)}`;

describe("Twilio's request signature", () => {
  // The worked example published in Twilio's security documentation.
  const example = {
    authToken: "12345",
    url: "https://mycompany.com/myapp.php?foo=1&bar=2",
    params: { CallSid: "CA1234567890ABCDE", Caller: "+14158675310", Digits: "1234", From: "+14158675310", To: "+18005551212" },
  };

  test("matches Twilio's published example", () => {
    assert.equal(twilioSignature(example), "GvWf1cFY/Q7PnoempGyD5oXAezc=");
    assert.ok(verifyTwilioSignature({ ...example, signature: "GvWf1cFY/Q7PnoempGyD5oXAezc=" }));
  });

  test("the order the parameters arrive in does not matter; a repeated name contributes every value", () => {
    const shuffled = Object.fromEntries(Object.entries(example.params).reverse());
    assert.equal(twilioSignature({ ...example, params: shuffled }), twilioSignature(example));
    const repeated = twilioSignature({ ...example, params: { A: ["2", "1"] } });
    assert.equal(repeated, twilioSignature({ ...example, params: { A: ["1", "2"] } }));
  });

  test("anything changed — a parameter, the URL, the token — or no signature at all is refused", () => {
    const signature = twilioSignature(example);
    assert.ok(!verifyTwilioSignature({ ...example, params: { ...example.params, To: "+18005559999" }, signature }));
    assert.ok(!verifyTwilioSignature({ ...example, url: "https://mycompany.com/other.php?foo=1&bar=2", signature }));
    assert.ok(!verifyTwilioSignature({ ...example, authToken: "54321", signature }));
    assert.ok(!verifyTwilioSignature({ ...example, signature: null }));
    assert.ok(!verifyTwilioSignature({ ...example, signature: "short" }));
    assert.ok(!verifyTwilioSignature({ ...example, authToken: "", signature }));
  });
});

describe("signed tokens", () => {
  const secret = "s";
  test("round trip, and every way of being wrong is null", () => {
    const token = signToken("xfer", { p: ["+1"], i: 0 }, { secret, ttlMs: 1000, now: 1000 });
    assert.deepEqual(verifyToken("xfer", token, { secret, now: 1500 }), { k: "xfer", e: 2000, p: ["+1"], i: 0 });
    assert.equal(verifyToken("xfer", token, { secret, now: 2001 }), null, "expired");
    assert.equal(verifyToken("other", token, { secret, now: 1500 }), null, "another kind of token");
    assert.equal(verifyToken("xfer", token, { secret: "x", now: 1500 }), null, "another secret");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), p: ["+9"] })).toString("base64url");
    assert.equal(verifyToken("xfer", `${forged}.${sig}`, { secret, now: 1500 }), null, "changed contents");
    for (const bad of [null, "", "a", "a.b.c", undefined]) assert.equal(verifyToken("xfer", bad, { secret }), null);
  });
});

describe("TwiML", () => {
  test("a caller-controlled string can never add a verb to the call", () => {
    const xml = sayOnly(`Hi </Say><Dial>+10000000000</Dial><Say>`);
    assert.ok(!xml.includes("<Dial>"));
    assert.match(xml, /&lt;\/Say&gt;&lt;Dial&gt;/);
  });

  test("the documents have the shape Twilio expects", () => {
    assert.equal(sayAndHangup("Bye"), '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="en-US">Bye</Say><Hangup/></Response>');
    assert.equal(hangup(), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    assert.equal(
      connectStream({ url: "wss://v.example.com/twilio", parameters: { ticket: "a.b" } }),
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://v.example.com/twilio"><Parameter name="ticket" value="a.b"/></Stream></Connect><Hangup/></Response>'
    );
    assert.match(dialNumber({ number: "+923001234567", timeoutSec: 20, action: "https://e.com/x?t=1&u=2", whisperUrl: "https://e.com/w" }), /<Dial timeout="20" action="https:\/\/e\.com\/x\?t=1&amp;u=2" answerOnBridge="true"><Number url="https:\/\/e\.com\/w">\+923001234567<\/Number><\/Dial>/);
  });
});

describe("where Twilio and we find each other", () => {
  test("addresses come from the environment, trailing slashes tidied, ws for the stream", () => {
    const c = twilioConfig(ENV);
    assert.equal(c.voiceWebhookUrl, "https://engine.example.com/api/telephony/twilio/voice");
    assert.equal(c.streamUrl, "wss://voice.example.com/twilio");
    assert.ok(c.canAnswer && c.canTransfer);
  });

  test("PUBLIC_APP_URL is the fallback base; nothing set means nothing works (and the setup says what is missing)", () => {
    assert.equal(twilioConfig({ PUBLIC_APP_URL: "https://x.example.com" }).baseUrl, "https://x.example.com");
    const none = describeTwilioSetup({});
    assert.deepEqual(none.missing, ["TWILIO_AUTH_TOKEN", "TWILIO_WEBHOOK_BASE_URL", "VOICE_GATEWAY_PUBLIC_URL"]);
    assert.equal(none.ready, false);
    assert.equal(twilioConfig({ TWILIO_AUTH_TOKEN: "t", PUBLIC_APP_URL: "https://x" }).canTransfer, false, "transfers also need the account sid");
    const ready = describeTwilioSetup(ENV);
    assert.deepEqual([ready.ready, ready.missing, ready.transfers], [true, [], true]);
    assert.ok(!JSON.stringify(ready).includes(ENV.TWILIO_AUTH_TOKEN), "never a secret's value");
  });
});

describe("a call comes in", () => {
  const route = { ok: true, tenantId: "t1", agentId: "agent-1", numberId: "n1", e164: "+442071234567" };
  const answer = (params, extra = {}) =>
    answerInboundCall({ params: { To: "+442071234567", From: "+923001234567", CallSid: CALL_SID, ...params }, env: ENV, resolve: async () => route, now: 1_000, ...extra });

  test("the dialled number's business and agent get the call: a stream to the gateway with a signed ticket", async () => {
    const { xml, outcome } = await answer({});
    assert.equal(outcome.result, "connected");
    assert.match(xml, /<Connect><Stream url="wss:\/\/voice\.example\.com\/twilio">/);
    const ticket = /name="ticket" value="([^"]+)"/.exec(xml)[1];
    const verdict = createTicketVerifier({ secret: ENV.VOICE_SESSION_SECRET, now: () => 2_000 }).verify(ticket);
    assert.deepEqual(verdict, { ok: true, tenantId: "t1", agentId: "agent-1", line: { numberId: "n1", toNumber: "+442071234567", fromNumber: "+923001234567" } });
  });

  test("the number is looked up as Twilio sent it; 'Called' is used when 'To' is missing", async () => {
    const seen = [];
    await answerInboundCall({ params: { Called: "+442071234567" }, env: ENV, resolve: async (n) => (seen.push(n), route) });
    assert.deepEqual(seen, ["+442071234567"]);
  });

  test("a withheld or SIP caller id is not recorded as a phone number", async () => {
    for (const From of ["anonymous", "+266696687", "sip:alice@example.com", ""]) {
      const { xml } = await answer({ From });
      const verdict = createTicketVerifier({ secret: ENV.VOICE_SESSION_SECRET, now: () => 2_000 }).verify(/name="ticket" value="([^"]+)"/.exec(xml)[1]);
      assert.ok(verdict.line.fromNumber === null || /^\+\d{8,15}$/.test(verdict.line.fromNumber), From);
    }
    const { xml } = await answer({ From: "anonymous" });
    assert.equal(createTicketVerifier({ secret: ENV.VOICE_SESSION_SECRET, now: () => 2_000 }).verify(/name="ticket" value="([^"]+)"/.exec(xml)[1]).line.fromNumber, null);
  });

  test("every refusal — unknown, released, unlinked, archived, suspended — is the same polite line and a hang-up, with the reason kept for the log", async () => {
    for (const reason of ["unknown", "released", "unassigned", "agent_archived", "tenant_unserviceable", "invalid_number"]) {
      const { xml, outcome } = await answer({}, { resolve: async () => ({ ok: false, reason }) });
      assert.match(xml, /not in service/);
      assert.match(xml, /<Hangup\/>/);
      assert.ok(!xml.includes("<Connect>"), `${reason} must never reach an agent`);
      assert.deepEqual([outcome.result, outcome.reason], ["refused", reason]);
    }
  });

  test("a business that starts too many calls is slowed, politely", async () => {
    const { xml, outcome } = await answer({}, { limit: () => ({ ok: false }) });
    assert.equal(outcome.result, "limited");
    assert.ok(!xml.includes("<Connect>"));
    assert.ok(INBOUND_LIMIT.limit >= 60, "far above what a real business gets");
  });

  test("no public gateway address, or no secret: an honest apology, never a stream to nowhere", async () => {
    const noGateway = await answer({}, { env: { ...ENV, VOICE_GATEWAY_PUBLIC_URL: "" } });
    assert.equal(noGateway.outcome.result, "misconfigured");
    assert.match(noGateway.xml, /trouble taking your call/);
    const noSecret = await answer({}, { env: { ...ENV, VOICE_SESSION_SECRET: "", NODE_ENV: "production" } });
    assert.equal(noSecret.outcome.result, "misconfigured");
  });
});

describe("a transfer, person by person", () => {
  const contacts = [
    { phone: "+923001234567", role: "Representative", name: "Bilal" },
    { phone: "+923215551234", role: "Senior doctor", name: "Dr Ayesha" },
    { phone: "+923335550000", role: "Owner", name: "Sara" },
  ];
  const config = twilioConfig(ENV);
  const secret = ENV.VOICE_SESSION_SECRET;
  const first = buildTransferTwiml({ contacts, index: 0, summary: "The caller asked to speak to a person.", config, secret, now: 1_000 });
  const tokenOf = (xml) => /\?t=([A-Za-z0-9_.-]+)/.exec(xml)[1];

  test("the first person is rung, with a summary for them and the way to the next", () => {
    assert.match(first, /<Number url="https:\/\/engine\.example\.com\/api\/telephony\/twilio\/whisper\?t=[^"]+">\+923001234567<\/Number>/);
    assert.match(first, /action="https:\/\/engine\.example\.com\/api\/telephony\/twilio\/transfer\?t=/);
    assert.match(first, /timeout="20"/);
    assert.equal(buildTransferTwiml({ contacts, index: 3, config, secret }), null);
  });

  test("not answered: the next person; and the next; then a fixed line and goodbye", () => {
    const env = ENV;
    const second = continueTransfer({ token: tokenOf(first), params: { DialCallStatus: "no-answer" }, env, now: 2_000 });
    assert.equal(second.outcome.result, "next");
    assert.match(second.xml, />\+923215551234<\/Number>/);
    const third = continueTransfer({ token: tokenOf(second.xml), params: { DialCallStatus: "busy" }, env, now: 3_000 });
    assert.match(third.xml, />\+923335550000<\/Number>/);
    const end = continueTransfer({ token: tokenOf(third.xml), params: { DialCallStatus: "failed" }, env, now: 4_000 });
    assert.equal(end.outcome.result, "exhausted");
    assert.match(end.xml, /nobody is available to take your call/);
    assert.match(end.xml, /<Hangup\/>/);
  });

  test("answered and finished: the call simply ends", () => {
    for (const DialCallStatus of ["completed", "answered"]) {
      const done = continueTransfer({ token: tokenOf(first), params: { DialCallStatus }, env: ENV, now: 2_000 });
      assert.deepEqual([done.outcome.result, done.xml], ["finished", hangup()]);
    }
  });

  test("a forged, expired or missing state rings nobody", () => {
    const [payload, sig] = tokenOf(first).split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url")), p: ["+10000000000", "+10000000001"] })).toString("base64url");
    for (const token of [`${forged}.${sig}`, null, "junk"]) {
      const result = continueTransfer({ token, params: { DialCallStatus: "no-answer" }, env: ENV, now: 2_000 });
      assert.equal(result.outcome.result, "invalid");
      assert.ok(!result.xml.includes("<Dial"));
    }
    assert.equal(continueTransfer({ token: tokenOf(first), params: { DialCallStatus: "no-answer" }, env: ENV, now: 1_000 + 11 * 60_000 }).outcome.result, "invalid");
  });

  test("what the person who picks up hears: the summary, escaped, and nothing from an unreadable state", () => {
    assert.match(whisperTwiml(tokenOf(first), { env: ENV, now: 2_000 }), /Incoming call from your AI assistant\. The caller asked to speak to a person\./);
    const nasty = buildTransferTwiml({ contacts, index: 0, summary: "<Dial>+1</Dial>", config, secret, now: 1_000 });
    const spoken = whisperTwiml(tokenOf(nasty), { env: ENV, now: 2_000 });
    assert.ok(!spoken.includes("<Dial>"));
    assert.equal(whisperTwiml("junk", { env: ENV }), sayOnly("Incoming call from your AI assistant."));
  });

  test("the summary is cut to what can be said in a breath", () => {
    const long = buildTransferTwiml({ contacts, index: 0, summary: "word ".repeat(300), config, secret, now: 1_000 });
    assert.ok(whisperTwiml(tokenOf(long), { env: ENV, now: 2_000 }).length < 600);
  });
});

describe("changing a live call through Twilio's API", () => {
  const args = { accountSid: ENV.TWILIO_ACCOUNT_SID, authToken: "tok", callSid: CALL_SID, twiml: "<Response/>" };

  test("one authenticated POST to the call's own address, with the new instructions", async () => {
    let seen;
    const result = await redirectCall({ ...args, fetchImpl: async (url, init) => ((seen = { url, init }), { ok: true }) });
    assert.deepEqual(result, { ok: true });
    assert.equal(seen.url, `https://api.twilio.com/2010-04-01/Accounts/${ENV.TWILIO_ACCOUNT_SID}/Calls/${CALL_SID}.json`);
    assert.equal(seen.init.method, "POST");
    assert.equal(seen.init.headers.authorization, `Basic ${Buffer.from(`${ENV.TWILIO_ACCOUNT_SID}:tok`).toString("base64")}`);
    assert.equal(new URLSearchParams(seen.init.body).get("Twiml"), "<Response/>");
  });

  test("a refusal, an unreachable Twilio and a malformed id are each a quiet failure — never a throw, never a request", async () => {
    assert.deepEqual(await redirectCall({ ...args, fetchImpl: async () => ({ ok: false, status: 404 }) }), { ok: false, reason: "rejected", status: 404 });
    assert.deepEqual(await redirectCall({ ...args, fetchImpl: async () => { throw new Error("offline"); } }), { ok: false, reason: "unreachable" });
    let calls = 0;
    const never = async () => (calls++, { ok: true });
    for (const bad of [{ callSid: "../../etc" }, { accountSid: "ACxyz" }, { authToken: "" }, { twiml: "" }]) {
      assert.deepEqual(await redirectCall({ ...args, ...bad, fetchImpl: never }), { ok: false, reason: "invalid" });
    }
    assert.equal(calls, 0);
  });
});

describe("only Twilio may call the webhooks", () => {
  const url = "https://engine.example.com/api/telephony/twilio/voice";
  const params = { To: "+442071234567", From: "+923001234567", CallSid: CALL_SID };
  const request = ({ body = new URLSearchParams(params).toString(), signature, pathname = "/api/telephony/twilio/voice", search = "" } = {}) => ({
    text: async () => body,
    nextUrl: { pathname, search },
    headers: { get: (name) => (name === "x-twilio-signature" ? signature : null) },
  });

  test("a correctly signed request is read; the parameters come back as a plain object", async () => {
    const signature = twilioSignature({ authToken: ENV.TWILIO_AUTH_TOKEN, url, params });
    assert.deepEqual(await readVerifiedTwilioRequest(request({ signature }), ENV), { ok: true, params });
  });

  test("the query string is part of what was signed (a transfer's state cannot be swapped)", async () => {
    const signed = twilioSignature({ authToken: ENV.TWILIO_AUTH_TOKEN, url: `${url}?t=abc`, params });
    assert.equal((await readVerifiedTwilioRequest(request({ signature: signed, search: "?t=abc" }), ENV)).ok, true);
    assert.equal((await readVerifiedTwilioRequest(request({ signature: signed, search: "?t=xyz" }), ENV)).status, 403);
  });

  test("no signature, a wrong one, another URL, a changed body: 403; not configured: 503; absurdly large: 413", async () => {
    const good = twilioSignature({ authToken: ENV.TWILIO_AUTH_TOKEN, url, params });
    assert.equal((await readVerifiedTwilioRequest(request({ signature: undefined }), ENV)).status, 403);
    assert.equal((await readVerifiedTwilioRequest(request({ signature: "AAAA" }), ENV)).status, 403);
    assert.equal((await readVerifiedTwilioRequest(request({ signature: good, pathname: "/api/telephony/twilio/transfer" }), ENV)).status, 403);
    assert.equal((await readVerifiedTwilioRequest(request({ signature: good, body: new URLSearchParams({ ...params, To: "+10000000000" }).toString() }), ENV)).status, 403);
    assert.equal((await readVerifiedTwilioRequest(request({ signature: good }), {})).status, 503, "unsigned requests are never accepted just because nothing is configured");
    assert.equal((await readVerifiedTwilioRequest(request({ signature: good, body: "a=".padEnd(70_000, "x") }), ENV)).status, 413);
  });
});
