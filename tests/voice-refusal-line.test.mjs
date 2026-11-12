import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { MAX_SPEAKING, MAX_WAIT_MS, PLAYBACK_SLACK_MS, REFUSAL_LINES, prewarmRefusalLines, speakRefusal } from "@/lib/voice/refusal-line";
import { voiceLine } from "@/lib/agent/prompt";

/** A phone transport that records what it was given, a TTS that answers with `seconds` of audio, a config that says `language`. */
function fixture({ language = "en", seconds = 3, streamSid = "MZ1", configError = null, ttsError = null, open = () => true } = {}) {
  const sent = [];
  const synth = [];
  const waits = [];
  const transport = { streamSid, audio: (samples, rate) => sent.push({ n: samples.length, rate }) };
  const tts = {
    synthesize: async (args) => {
      synth.push(args);
      if (ttsError) throw ttsError;
      return { samples: new Float32Array(Math.round(seconds * 24000)), sampleRate: 24000 };
    },
  };
  const getAgentConfig = async (tenantId, options) => {
    if (configError) throw configError;
    return { replyLanguage: language, voices: { en: "kokoro:bm_fable" }, _asked: { tenantId, ...options } };
  };
  return { sent, synth, waits, transport, tts, getAgentConfig, isOpen: open, sleep: async (ms) => void waits.push(ms) };
}

const okVerdict = { ok: true, tenantId: "t1", agentId: "a1" };

describe("a refused phone call is told out loud", () => {
  test("which reasons are voiced, with which line", () => {
    assert.deepEqual(REFUSAL_LINES, { busy: "busy", tenant_busy: "busy", not_ready: "fallback", not_in_service: "not_in_service" });
  });

  test("a gateway at capacity says its fixed busy line, in the agent's voice, and waits for it to be heard", async () => {
    const f = fixture({ seconds: 3 });
    const result = await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...f });
    assert.equal(result.spoken, true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.synth.length, 1);
    assert.equal(f.synth[0].text, voiceLine("busy", "en"));
    assert.equal(f.synth[0].voiceId, "kokoro:bm_fable", "the agent's own voice for that language");
    assert.equal(f.synth[0].cache, true, "a fixed line is made once and then served from the cache");
    const waited = f.waits.reduce((a, b) => a + b, 0);
    assert.ok(waited >= 3000 + PLAYBACK_SLACK_MS - 250 && waited <= 3000 + PLAYBACK_SLACK_MS, `waited ${waited} ms for 3 s of audio`);
  });

  test("an Urdu agent's callers are told in Urdu, with that agent's Urdu voice", async () => {
    const f = fixture({ language: "ur" });
    await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...f });
    assert.equal(f.synth[0].text, voiceLine("busy", "ur"));
    assert.equal(f.synth[0].language, "ur");
    assert.match(f.synth[0].voiceId, /^kokoro:/);
  });

  test("a business that is not in service hears that line, not 'busy'", async () => {
    const f = fixture();
    await speakRefusal({ refusal: { code: "bad_ticket", line: "not_in_service" }, verdict: okVerdict, ...f });
    assert.equal(f.synth[0].text, voiceLine("not_in_service", "en"));
  });

  test("an agent that cannot be read is spoken to in English with the default voice", async () => {
    const f = fixture({ configError: new Error("db down") });
    const result = await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...f });
    assert.equal(result.spoken, true);
    assert.equal(result.language, "en");
    assert.equal(f.synth[0].text, voiceLine("busy", "en"));
  });

  test("a reason without a line gets nothing said (and nothing is synthesised)", async () => {
    const f = fixture();
    const result = await speakRefusal({ refusal: { code: "bad_ticket" }, verdict: okVerdict, ...f });
    assert.deepEqual(result, { spoken: false, reason: "no_line" });
    assert.equal(f.synth.length, 0);
    assert.equal(f.sent.length, 0);
  });

  test("SECURITY: a ticket that did not verify is never spoken to, whatever the refusal says", async () => {
    const f = fixture();
    const result = await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: { ok: false, reason: "bad signature" }, ...f });
    assert.deepEqual(result, { spoken: false, reason: "unverified" });
    assert.equal(f.sent.length, 0);
    assert.equal(f.synth.length, 0, "no CPU spent on a caller who proved nothing");
  });

  test("no stream to speak into, or the caller already hung up: nothing is sent", async () => {
    const noStream = fixture({ streamSid: null });
    assert.equal((await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...noStream })).reason, "no_stream");
    const gone = fixture({ open: () => false });
    assert.equal((await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...gone })).reason, "closed");
    assert.equal(noStream.sent.length + gone.sent.length, 0);
  });

  test("FAIL OPEN: a synthesis that fails leaves the plain close, and does not throw", async () => {
    const f = fixture({ ttsError: new Error("voice missing") });
    const result = await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...f });
    assert.deepEqual(result, { spoken: false, reason: "tts_failed" });
    assert.equal(f.sent.length, 0);
  });

  test("the caller hanging up while the line plays ends the wait at once", async () => {
    const f = fixture({ seconds: 10 });
    f.isOpen = (() => {
      let calls = 0;
      return () => ++calls <= 4; // open for the checks before sending and for two wait steps, then gone
    })();
    const result = await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...f });
    assert.equal(result.spoken, true);
    assert.ok(f.waits.length <= 3, `stopped waiting (${f.waits.length} steps)`);
  });

  test("a very long line never holds a refused caller past the cap", async () => {
    const f = fixture({ seconds: 60 });
    await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...f });
    assert.ok(f.waits.reduce((a, b) => a + b, 0) <= MAX_WAIT_MS);
  });

  test("a flood: at most MAX_SPEAKING are voiced at once, the rest are closed silently as before", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = fixture();
    slow.tts = { synthesize: async () => { await gate; return { samples: new Float32Array(2400), sampleRate: 24000 }; } };
    const started = [];
    for (let i = 0; i < MAX_SPEAKING; i++) {
      started.push(speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...slow }));
    }
    await new Promise((r) => setImmediate(r));
    const overflow = await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...fixture() });
    assert.deepEqual(overflow, { spoken: false, reason: "too_many" });
    release();
    const results = await Promise.all(started);
    assert.equal(results.filter((r) => r.spoken).length, MAX_SPEAKING);
    // and once they are done, the next one is voiced again
    assert.equal((await speakRefusal({ refusal: { code: "busy", line: "busy" }, verdict: okVerdict, ...fixture() })).spoken, true);
  });

  test("pre-warming makes the busy line in both languages, with the default voices, cached", async () => {
    const calls = [];
    await prewarmRefusalLines({ synthesize: async (a) => void calls.push(a) });
    assert.deepEqual(calls.map((c) => c.language), ["en", "ur"]);
    assert.ok(calls.every((c) => c.cache === true));
    assert.deepEqual(calls.map((c) => c.text), [voiceLine("busy", "en"), voiceLine("busy", "ur")]);
    // a missing voice does not stop the gateway from starting
    await assert.doesNotReject(prewarmRefusalLines({ synthesize: async () => { throw new Error("no voice"); } }));
  });
});
