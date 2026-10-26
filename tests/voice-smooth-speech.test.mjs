import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { trimSilence, withTrailingSilence } from "@/lib/voice/audio";
import { SentenceChunker, chunkEnding, FIRST_CHUNK_CHARS } from "@/lib/voice/sentences";

// No long silences inside the agent's own sentences (CLAUDE.md §6.24): the engine's quiet at
// each end of a piece is trimmed, the pause after a piece depends on where it ended, and a
// sentence is never cut right after a word that leads into the next one.

const RATE = 16_000;
/** `leadMs` of quiet, `speechMs` of a 200 Hz tone, `tailMs` of quiet. */
function tone({ leadMs, speechMs, tailMs, amplitude = 0.5, noise = 0.0005 }) {
  const n = (ms) => Math.round((RATE * ms) / 1000);
  const out = new Float32Array(n(leadMs) + n(speechMs) + n(tailMs));
  for (let i = 0; i < out.length; i++) out[i] = (Math.random() - 0.5) * 2 * noise;
  for (let i = 0; i < n(speechMs); i++) out[n(leadMs) + i] = amplitude * Math.sin((2 * Math.PI * 200 * i) / RATE);
  return out;
}
const ms = (samples) => Math.round((samples.length / RATE) * 1000);

describe("trimming the engine's own silence", () => {
  test("quiet at both ends is cut down to what is kept (20 ms before, 40 ms after)", () => {
    const { samples, leadMs, tailMs } = trimSilence(tone({ leadMs: 90, speechMs: 600, tailMs: 120 }), RATE, { keepLeadMs: 20, keepTailMs: 40 });
    assert.ok(Math.abs(ms(samples) - (20 + 600 + 40)) <= 10, `kept ${ms(samples)} ms`);
    assert.ok(Math.abs(leadMs - 70) <= 5 && Math.abs(tailMs - 80) <= 5, `cut ${leadMs} / ${tailMs}`);
  });

  test("a soft sound is speech too: nothing of the voice is clipped", () => {
    const loud = tone({ leadMs: 0, speechMs: 300, tailMs: 0 });
    const soft = tone({ leadMs: 0, speechMs: 100, tailMs: 0, amplitude: 0.03 }); // a quiet "s" at the end
    const both = new Float32Array(loud.length + soft.length + 1600);
    both.set(loud);
    both.set(soft, loud.length);
    const { samples } = trimSilence(both, RATE, { keepLeadMs: 0, keepTailMs: 0 });
    assert.ok(ms(samples) >= 395, `${ms(samples)} ms kept — the soft ending survives`);
  });

  test("audio with nothing above the threshold is returned untouched", () => {
    const silence = new Float32Array(RATE / 2);
    assert.equal(trimSilence(silence, RATE).samples, silence);
    assert.equal(trimSilence(new Float32Array(3), RATE).samples.length, 3);
  });

  test("the pause is added back exactly", () => {
    const base = new Float32Array(1000);
    assert.equal(withTrailingSilence(base, RATE, 0), base);
    assert.equal(withTrailingSilence(base, RATE, 240).length, 1000 + 3840);
  });
});

describe("where a piece ended decides the pause after it", () => {
  test("a sentence, a comma, or a join in the middle of a sentence", () => {
    assert.equal(chunkEnding("We open at nine."), "sentence");
    assert.equal(chunkEnding("Is that right?"), "sentence");
    assert.equal(chunkEnding("کلینک کھلا ہے۔"), "sentence");
    assert.equal(chunkEnding("کیا آپ آ سکتے ہیں؟"), "sentence");
    assert.equal(chunkEnding('He said "yes."'), "sentence");
    assert.equal(chunkEnding("Our clinic is open from nine,"), "comma");
    assert.equal(chunkEnding("جی، ہمارا کلینک صبح نو بجے سے کھلا ہے،"), "comma");
    assert.equal(chunkEnding("Could you please tell me your name"), "joined");
  });
});

describe("cutting a long sentence", () => {
  const cut = (text) => {
    const chunker = new SentenceChunker();
    return [...chunker.push(text), ...chunker.flush()];
  };

  test("never right after a word that leads into the next one ('about | your name')", () => {
    // No comma and no joining word in the first chunk's window, so it breaks at a space. The last
    // space within 48 characters falls right after "about" — the cut used to land exactly there.
    const text = "Could you kindly please tell me everything about your new booking options today?";
    assert.equal(text.slice(0, text.lastIndexOf(" ", FIRST_CHUNK_CHARS)), "Could you kindly please tell me everything about");
    const pieces = cut(text);
    assert.deepEqual(pieces, ["Could you kindly please tell me everything", "about your new booking options today?"]);
  });

  test("in Urdu, never just before a postposition ('آپ | کا نام')", () => {
    const pieces = cut("براہِ کرم مجھے اپنے پورے نام کے ساتھ آپ کا موبائل فون نمبر بھی بتا دیجیے تاکہ ہماری ٹیم رابطہ کرے");
    for (let i = 1; i < pieces.length; i++) {
      assert.doesNotMatch(pieces[i], /^(کا|کی|کے|کو|سے|میں|پر|نے|ہے|ہیں)\s/u, `piece ${i + 1} starts on a postposition: "${pieces[i]}"`);
    }
  });

  test("a tiny first sentence ('Sure!') never goes out alone before a long one", () => {
    const pieces = cut("Sure! A root canal treatment usually takes two visits, and the fee depends on the tooth, which our dentist will confirm after a quick check-up.");
    assert.match(pieces[0], /^Sure! A root canal/);
    assert.deepEqual(cut("Sure! We open at nine."), ["Sure! We open at nine."]);
  });

  test("never right after a number ('two | visits')", () => {
    const pieces = cut("A root canal treatment usually takes about two visits here at our clinic in total for most adult patients today.");
    for (const p of pieces.slice(0, -1)) assert.doesNotMatch(p, /\b(?:two|\d+)$/, `"${p}" ends on a number`);
  });
});
