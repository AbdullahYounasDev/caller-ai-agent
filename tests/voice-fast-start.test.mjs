import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { VOICES, SPEECH_LEVEL_DB, FAST_START_VOICE_IDS, getVoice, fastStartVoiceFor, fastStartGainDb } from "@/lib/voice/speech/voices";
import { fastFirstChunkEnabled } from "@/lib/voice/config";
import { applyGainDb } from "@/lib/voice/audio";

// The fast start's building blocks (CLAUDE.md §6.24): which fast voice opens for which natural one, by how many dB it
// is corrected, whether the feature is on, and the gain itself. The call flow is in voice-session.test.mjs.

describe("which fast voice opens for which natural voice", () => {
  test("a natural English voice gets the fast voice of its own gender, and nothing else gets one", () => {
    assert.equal(fastStartVoiceFor(getVoice("kokoro:af_heart")).id, "piper:en_US-lessac-medium");
    assert.equal(fastStartVoiceFor(getVoice("kokoro:bf_emma")).id, "piper:en_US-lessac-medium");
    assert.equal(fastStartVoiceFor(getVoice("kokoro:am_michael")).id, "piper:en_US-ryan-medium");
    assert.equal(fastStartVoiceFor(getVoice("kokoro:bm_fable")).id, "piper:en_US-ryan-medium");
  });

  test("every natural English voice has a partner of its own gender", () => {
    for (const v of VOICES.filter((x) => x.engine === "kokoro" && x.language === "en")) {
      const fast = fastStartVoiceFor(v);
      assert.ok(fast, v.id);
      assert.equal(fast.gender, v.gender, v.id);
      assert.equal(fast.tier, "fast");
    }
  });

  test("Urdu, a voice that is already fast, and an unknown voice have no partner", () => {
    assert.equal(fastStartVoiceFor(getVoice("kokoro:hf_alpha")), null, "there is no fast Urdu voice");
    assert.equal(fastStartVoiceFor(getVoice("kokoro:hm_omega")), null);
    assert.equal(fastStartVoiceFor(getVoice("piper:en_US-ryan-medium")), null, "nothing to switch from");
    assert.equal(fastStartVoiceFor(null), null);
    assert.equal(fastStartVoiceFor(getVoice("nope")), null);
  });

  test("FAST_START_VOICE_IDS is exactly the fast English voices, for the gateway to load before the first call", () => {
    assert.deepEqual([...FAST_START_VOICE_IDS].sort(), ["piper:en_US-lessac-medium", "piper:en_US-ryan-medium"]);
  });
});

describe("matching the level", () => {
  test("every English voice has a measured level, and the table names no voice that does not exist", () => {
    for (const v of VOICES.filter((x) => x.language === "en")) assert.ok(Number.isFinite(SPEECH_LEVEL_DB[v.id]), `no level for ${v.id}`);
    for (const id of Object.keys(SPEECH_LEVEL_DB)) assert.ok(getVoice(id), `${id} is not a voice`);
  });

  test("the gain brings the fast voice to the natural voice's level: natural minus fast", () => {
    const lessac = getVoice("piper:en_US-lessac-medium");
    const ryan = getVoice("piper:en_US-ryan-medium");
    assert.equal(fastStartGainDb(getVoice("kokoro:af_heart"), lessac), -1.7); // -23.7 - (-22.0)
    assert.equal(fastStartGainDb(getVoice("kokoro:af_aoede"), lessac), 2.6); // a LOUDER Kokoro voice: boosted
    assert.equal(fastStartGainDb(getVoice("kokoro:bm_fable"), ryan), -4);
    assert.equal(fastStartGainDb(getVoice("kokoro:am_fenrir"), ryan), 0); // already the same level
  });

  test("the whole catalogue stays within a moderate correction, so a wrong entry cannot make a shout", () => {
    for (const v of VOICES.filter((x) => x.engine === "kokoro" && x.language === "en")) {
      const gain = fastStartGainDb(v, fastStartVoiceFor(v));
      assert.ok(Math.abs(gain) <= 6, `${v.id}: ${gain} dB`);
    }
  });

  test("an unknown level means no correction, and the correction is capped at 6 dB", () => {
    assert.equal(fastStartGainDb({ id: "kokoro:nobody" }, getVoice("piper:en_US-ryan-medium")), 0);
    assert.equal(fastStartGainDb(getVoice("kokoro:af_heart"), { id: "piper:nobody" }), 0);
    assert.equal(fastStartGainDb(null, null), 0);
  });
});

describe("applyGainDb", () => {
  const samples = Float32Array.from([0, 0.1, -0.1, 0.5, -0.5]);

  test("+6.02 dB doubles the amplitude, -6.02 dB halves it, and the input is never modified", () => {
    const louder = applyGainDb(samples, 6.0206);
    assert.ok(Math.abs(louder[3] - 1) < 1e-4);
    const quieter = applyGainDb(samples, -6.0206);
    assert.ok(Math.abs(quieter[3] - 0.25) < 1e-4);
    assert.deepEqual([...samples], [0, 0.1, -0.1, 0.5, -0.5].map(Math.fround));
    assert.notEqual(louder, samples);
  });

  test("a boost holds at full scale instead of wrapping around", () => {
    const out = applyGainDb(Float32Array.from([0.9, -0.9]), 6);
    assert.deepEqual([...out], [1, -1]);
  });

  test("0 dB, nothing and nonsense return the input as it is", () => {
    assert.equal(applyGainDb(samples, 0), samples);
    assert.equal(applyGainDb(samples, undefined), samples);
    assert.equal(applyGainDb(samples, NaN), samples);
  });
});

describe("turning it on", () => {
  test("OFF unless VOICE_FAST_FIRST_CHUNK says so — nobody has listened to two engines in one reply yet", () => {
    assert.equal(fastFirstChunkEnabled({}), false);
    assert.equal(fastFirstChunkEnabled({ VOICE_FAST_FIRST_CHUNK: "" }), false);
    assert.equal(fastFirstChunkEnabled({ VOICE_FAST_FIRST_CHUNK: "0" }), false);
    assert.equal(fastFirstChunkEnabled({ VOICE_FAST_FIRST_CHUNK: "off" }), false);
    assert.equal(fastFirstChunkEnabled({ VOICE_FAST_FIRST_CHUNK: "maybe" }), false);
  });

  test("1, true, on and yes turn it on, in any case", () => {
    for (const v of ["1", "true", "TRUE", "on", "On", "yes", " 1 "]) assert.equal(fastFirstChunkEnabled({ VOICE_FAST_FIRST_CHUNK: v }), true, v);
  });
});
