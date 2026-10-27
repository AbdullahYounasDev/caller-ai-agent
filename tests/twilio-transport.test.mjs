import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createTwilioTransport, decodeTwilioMessage } from "@/lib/voice/transports/twilio";
import { float32ToMulaw } from "@/lib/voice/audio";
import { twilioConfig } from "@/lib/telephony/twilio-config";

// The Twilio Media Streams adapter (CLAUDE.md §6.30): Twilio's JSON in, the session's audio out, and a
// transfer that hands the call to the network. A fake socket stands in for Twilio.

const ENV = {
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`,
  TWILIO_WEBHOOK_BASE_URL: "https://engine.example.com",
  VOICE_GATEWAY_PUBLIC_URL: "https://voice.example.com",
  VOICE_SESSION_SECRET: "secret",
};
const CALL_SID = `CA${"c".repeat(32)}`;

function fakeSocket() {
  const ws = { OPEN: 1, readyState: 1, sent: [], closed: null, send: (m) => ws.sent.push(JSON.parse(m)), close: (code, reason) => ((ws.closed = { code, reason }), (ws.readyState = 3)) };
  return ws;
}
const transportOn = (ws, extra = {}) => {
  const transport = createTwilioTransport(ws, { env: ENV, sleep: async () => {}, ...extra });
  transport.bind({ streamSid: "MZ123", callSid: CALL_SID });
  return transport;
};
const secondOfTone = (rate) => Float32Array.from({ length: rate }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 440 * i) / rate));

describe("what Twilio sends", () => {
  test("the start message gives the stream, the call and the ticket", () => {
    const m = { event: "start", start: { streamSid: "MZ1", callSid: CALL_SID, customParameters: { ticket: "a.b" } } };
    assert.deepEqual(decodeTwilioMessage(JSON.stringify(m)), { kind: "start", streamSid: "MZ1", callSid: CALL_SID, ticket: "a.b" });
    assert.equal(decodeTwilioMessage(JSON.stringify({ event: "start", start: { streamSid: "MZ1", callSid: CALL_SID } })).ticket, null);
    assert.equal(decodeTwilioMessage(JSON.stringify({ event: "start", start: {} })).kind, "invalid");
  });

  test("only the CALLER's audio counts; the rest is ignored or invalid, never a throw", () => {
    assert.deepEqual(decodeTwilioMessage(JSON.stringify({ event: "media", media: { payload: "AAAA", track: "inbound" } })), { kind: "media", payload: "AAAA" });
    assert.deepEqual(decodeTwilioMessage(JSON.stringify({ event: "media", media: { payload: "AAAA" } })), { kind: "media", payload: "AAAA" });
    assert.equal(decodeTwilioMessage(JSON.stringify({ event: "media", media: { payload: "AAAA", track: "outbound" } })).kind, "ignored");
    assert.equal(decodeTwilioMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } })).kind, "ignored");
    assert.equal(decodeTwilioMessage(JSON.stringify({ event: "stop" })).kind, "stop");
    assert.equal(decodeTwilioMessage(JSON.stringify({ event: "connected" })).kind, "connected");
    assert.equal(decodeTwilioMessage("not json").kind, "invalid");
    assert.equal(decodeTwilioMessage(Buffer.from('{"event":"stop"}')).kind, "stop");
  });
});

describe("the caller's voice into the gateway", () => {
  test("20 ms of 8 kHz μ-law becomes 16 kHz samples, with no click at the frame edges", () => {
    const transport = transportOn(fakeSocket());
    const frames = [];
    const tone = secondOfTone(8000);
    for (let i = 0; i < 8000; i += 160) frames.push(transport.decode(float32ToMulaw(tone.subarray(i, i + 160)).toString("base64")));
    const total = frames.reduce((n, f) => n + f.length, 0);
    assert.ok(total >= 15_000 && total <= 16_000, `${total} samples`);
    // every sample stays inside what the tone could produce (a click would exceed it)
    for (const f of frames) for (const v of f) assert.ok(Math.abs(v) < 0.45);
  });
});

describe("the agent's voice out to the phone", () => {
  test("a spoken piece leaves as 20 ms μ-law frames in Twilio's media message, in order", () => {
    const ws = fakeSocket();
    transportOn(ws).audio(secondOfTone(24_000), 24_000);
    assert.equal(ws.sent.length, 50, "one second = fifty 20 ms frames");
    for (const m of ws.sent) {
      assert.equal(m.event, "media");
      assert.equal(m.streamSid, "MZ123");
      assert.equal(Buffer.from(m.media.payload, "base64").length, 160);
    }
  });

  test("any synthesis rate is brought to 8 kHz; a short last piece is sent as it is", () => {
    for (const rate of [22_050, 24_000, 16_000]) {
      const ws = fakeSocket();
      transportOn(ws).audio(secondOfTone(rate), rate);
      const bytes = ws.sent.reduce((n, m) => n + Buffer.from(m.media.payload, "base64").length, 0);
      assert.equal(bytes, 8000, `${rate} Hz`);
    }
    const ws = fakeSocket();
    transportOn(ws).audio(new Float32Array(100), 8000);
    assert.equal(Buffer.from(ws.sent[0].media.payload, "base64").length, 100);
  });

  test("barge-in clears what Twilio still has queued", () => {
    const ws = fakeSocket();
    transportOn(ws).clear();
    assert.deepEqual(ws.sent, [{ event: "clear", streamSid: "MZ123" }]);
  });

  test("before the stream has started, or after the socket is gone, nothing is sent and nothing throws", () => {
    const ws = fakeSocket();
    const unbound = createTwilioTransport(ws, { env: ENV });
    unbound.audio(secondOfTone(8000), 8000);
    unbound.clear();
    assert.equal(ws.sent.length, 0);
    const gone = fakeSocket();
    const transport = transportOn(gone);
    gone.readyState = 3;
    transport.audio(secondOfTone(8000), 8000);
    transport.clear();
    transport.close();
    assert.equal(gone.sent.length, 0);
  });

  test("the console's progress messages mean nothing to a phone; closing is a normal closure", () => {
    const ws = fakeSocket();
    const transport = transportOn(ws);
    transport.notify("event", { event: {} });
    assert.equal(ws.sent.length, 0);
    transport.close("agent_goodbye");
    assert.deepEqual(ws.closed, { code: 1000, reason: "call ended" });
  });
});

describe("passing the call to people", () => {
  const contacts = [{ id: "c1", phone: "+923001234567", role: "Representative", name: "Bilal" }, { id: "c2", phone: "+923215551234", role: "Doctor", name: "Ayesha" }];

  test("the live call's instructions are replaced with a <Dial> to the first person, after the last words have played", async () => {
    const order = [];
    let seen;
    const transport = transportOn(fakeSocket(), {
      sleep: async (ms) => order.push(`wait ${ms}`),
      fetchImpl: async (url, init) => (order.push("request"), (seen = { url, init }), { ok: true }),
    });
    const result = await transport.transferInOrder(contacts, { summary: "The caller asked to speak to a person." });
    assert.deepEqual(result, { connected: true });
    assert.deepEqual(order, ["wait 500", "request"]);
    assert.ok(seen.url.endsWith(`/Calls/${CALL_SID}.json`));
    const twiml = new URLSearchParams(seen.init.body).get("Twiml");
    assert.match(twiml, />\+923001234567<\/Number>/);
    assert.match(twiml, /transfer\?t=/);
  });

  test("Twilio refusing, or being unreachable, leaves the call with the agent", async () => {
    for (const fetchImpl of [async () => ({ ok: false, status: 500 }), async () => { throw new Error("down"); }]) {
      assert.deepEqual(await transportOn(fakeSocket(), { fetchImpl }).transferInOrder(contacts), { connected: false, reason: "failed" });
    }
  });

  test("with no REST credentials, no call id or nobody to ring, no request is made", async () => {
    let calls = 0;
    const fetchImpl = async () => (calls++, { ok: true });
    const noCreds = createTwilioTransport(fakeSocket(), { env: { ...ENV, TWILIO_ACCOUNT_SID: "" }, fetchImpl, sleep: async () => {} });
    noCreds.bind({ streamSid: "MZ", callSid: CALL_SID });
    assert.equal((await noCreds.transferInOrder(contacts)).connected, false);
    const unbound = createTwilioTransport(fakeSocket(), { env: ENV, fetchImpl, sleep: async () => {} });
    assert.equal((await unbound.transferInOrder(contacts)).connected, false);
    assert.equal((await transportOn(fakeSocket(), { fetchImpl }).transferInOrder([])).connected, false);
    assert.equal(calls, 0);
    assert.ok(twilioConfig(ENV).canTransfer);
  });
});
