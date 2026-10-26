/**
 * STREAMING TEXT → SPEAKABLE CHUNKS.
 *
 * The model streams its reply token by token. Waiting for the whole reply before
 * speaking would add the model's ENTIRE generation time to every turn; speaking each
 * token as it arrives is impossible (a TTS voice needs a phrase to get intonation
 * right). So the stream is cut into chunks — sentences, or natural phrases of one — and
 * each chunk is sent to speech the moment it is complete. The caller hears the first
 * one while the rest is still being written.
 *
 * ── PROGRESSIVE CHUNK SIZES ─────────────────────────────────────────────
 * Two constraints, and they pull in opposite directions:
 *   1. Time to first audio = synthesis time of the FIRST chunk — so it must be short.
 *   2. No gap mid-reply: chunk N+1 is synthesised while chunk N plays, so it must not take
 *      longer to synthesise than the audio already queued takes to play.
 * The natural voice (Kokoro) synthesises at ~0.57× real time on a laptop CPU (§6.24).
 * Measured failure: a 38-character first sentence (~2 s of audio) followed by a
 * 230-character second one (~5 s to synthesise) left the caller in ~3 s of silence in the
 * middle of the answer.
 *
 * The rule, derived rather than guessed. Chunks are synthesised back to back at r × their
 * own duration, and playback starts when chunk 1 is ready; chunk k is ready in time iff
 *     r·(L1 + … + Lk)  ≤  r·L1 + (L1 + … + Lk−1)
 *     ⇔  Lk  ≤  L1 + ((1 − r) / r) · (L1 + … + Lk−1)
 * With r = 0.67 (measured 0.57 in isolation; a live call measured a little slower, and an
 * 810 ms gap appeared with 0.6) that is L1 + 0.5 × everything already sent (characters
 * stand in for duration — they are proportional for one voice). So: the first chunk is
 * capped at FIRST_CHUNK_CHARS, each later one at `L1 + CHUNK_GROWTH × sent`, between
 * MIN_LATER_CHUNK_CHARS and MAX_CHUNK_CHARS — and the cap is STRICT: a comma just past it
 * is not taken (that slack is what caused the 810 ms gap). It follows what was REALLY
 * sent, not a fixed schedule. A sentence that fits its limit is spoken whole.
 *
 * A first sentence too short to cover the next one's synthesis ("Sure!" — half a second of
 * audio) is held and spoken together with the sentence after it, when both fit the first
 * chunk's limit.
 *
 * A sentence that does NOT fit is broken where a speaker would pause anyway: the last
 * comma (or ; : ، ) in the window, else before a STRONG joining word ("which", "because",
 * "according to", Urdu "کیونکہ"…), else before a weak one ("and", "or" — weak because they
 * often sit inside a noun phrase: "availability and support hours"), else at a space.
 * Never inside a word — and, at a plain space, never right after a word that leads into the
 * next one ("tell me about | your name", "the | price") or right before an Urdu postposition
 * ("آپ | کا نام"): spoken as two pieces, that join is heard as the agent stopping mid-thought.
 *
 * Where a chunk ended decides the pause after it (chunkEnding → TTS in config.js): a full
 * pause after a sentence, a short one at a comma, none at all between two pieces of one
 * sentence. And a call whose speech is being made slower than it plays (the CPU is busy) is
 * switched to whole sentences (`wholeSentences`): a gap then falls between sentences, where a
 * listener expects one, never in the middle of one.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Pure and dependency-free (tests/voice-units.test.mjs).
 */

export const FIRST_CHUNK_CHARS = 48;
export const CHUNK_GROWTH = 0.5;
/** Later chunks are never capped below this — shorter cuts land mid-phrase. */
export const MIN_LATER_CHUNK_CHARS = 40;
export const MAX_CHUNK_CHARS = 240;

/** No chunk is cut shorter than this — a two-word fragment sounds like a stammer. */
const MIN_CHUNK_CHARS = 18;

/**
 * The FIRST chunk may run to the next comma this far past its limit, rather than be cut
 * at a plain space ("…available Monday to | Friday,"). Safe for the first chunk only:
 * every later limit is computed from the first chunk's ACTUAL length, so the timing rule
 * still holds. Slack on a later chunk breaks it — measured: an 810 ms mid-reply gap.
 */
const FIRST_CHUNK_COMMA_SLACK = 1.25;

/** Words whose trailing period is NOT a sentence end (§7). */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "prof", "vs", "etc", "e.g", "i.e", "approx", "tel"]);

/**
 * A sentence ends at . ! ? … — or Urdu's ۔ (full stop) and ؟ (question mark) —
 * optionally followed by a closing quote or bracket, when whitespace follows: "149.00"
 * and "v1.2" never end one, because no space follows the dot. A line break also ends one.
 */
const BOUNDARY = /([.!?…۔؟]+["'”’)\]]*)(\s+)|(\n+)/g;

/** Pause punctuation inside a sentence (Latin and Urdu comma). */
const PAUSE = /[,;:،]\s/g;

/** Words that start a new clause — the best place to break a sentence that has no comma. */
const STRONG_JOINER =
  / (?=(?:but|so|because|which|who|while|until|unless|whereas|although|according to|including|except|لیکن|مگر|کیونکہ|جو|جب|تاکہ|اگرچہ)\s)/giu;
/** Words that MAY start a clause but often join two nouns — used only when nothing better exists. */
const WEAK_JOINER = / (?=(?:and|or|that|اور|یا|کہ)\s)/giu;

/**
 * A chunk must not END on one of these: each leads into the word after it ("about | your name",
 * "the | Pro plan", "can | help"). English, Urdu script and Roman Urdu.
 */
const LEADS_INTO = new Set(
  (
    "a an the my your our their his her its this that these those to of for with about from by in on at into onto as than " +
    "and or but nor so if very more most less not no is are was were be been am will would can could shall should may might must " +
    "do does did have has had i we they he she i'm i'd i'll you're we're it's please just also " +
    "اور یا کہ جو اگر لیکن مگر بھی میرا میری میرے آپ ہم یہ وہ اس ان " +
    "aur ya ke ki ka jo agar lekin magar bhi mera meri mere aap hum ye yeh woh is un"
  ).split(" ")
);

/**
 * A chunk must not START on one of these: Urdu postpositions and helpers attach to the word
 * BEFORE them ("آپ کا", "نام سے", "کیا ہے") — a piece that opens with one sounds broken off.
 */
const ATTACHES_BACK = new Set(
  ("کا کی کے کو سے میں پر نے تک ہی ہے ہیں تھا تھی تھے گا گی گے والا والی والے سکتے سکتی سکتا رہے رہی رہا " +
    "ka ki ke ko se mein par ne tak hi hai hain tha thi the ga gi ge wala wali wale sakte sakti sakta rahe rahi raha").split(" ")
);

const bareWord = (word) => String(word ?? "").toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");

/** A number leads into what it counts ("two | visits", "149 | euros", "پانچ | ہزار"). */
const NUMBER_WORD =
  /^(?:\p{N}+(?:[.,]\p{N}+)*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|ایک|دو|تین|چار|پانچ|چھ|سات|آٹھ|نو|دس|سو|ہزار|ek|aik|do|teen|char|paanch|chay|saat|aath|das|sau|hazar)$/u;

/** A plain space where a piece may end: not after a word that leads on, not before one that attaches back. */
function goodSpace(text, at) {
  const before = bareWord(text.slice(0, at).trimEnd().split(/\s+/).at(-1));
  const after = bareWord(text.slice(at).trimStart().split(/\s+/)[0]);
  return !LEADS_INTO.has(before) && !NUMBER_WORD.test(before) && !ATTACHES_BACK.has(after);
}

/** "Dr." or "e.g." — a single period after a known abbreviation. */
function endsWithAbbreviation(text) {
  const match = /(?:^|[^\p{L}.])([\p{L}.]+)\.$/u.exec(text.trimEnd());
  return Boolean(match) && ABBREVIATIONS.has(match[1].toLowerCase());
}

/** End index (exclusive) of the first real sentence end, and where the next one starts. */
function firstSentenceEnd(text) {
  BOUNDARY.lastIndex = 0;
  let match;
  while ((match = BOUNDARY.exec(text))) {
    const end = match.index + (match[3] ? 0 : match[1].length);
    if (match[3] || !endsWithAbbreviation(text.slice(0, end))) {
      return { end, next: match.index + match[0].length };
    }
  }
  return null;
}

/**
 * Where to break an over-long stretch: after a comma, before a joining word, at a space.
 * @param {string} text
 * @param {number} limit
 * @param {number} [commaLimit] how far a comma may be — `limit` except for the first chunk
 */
function breakPoint(text, limit, commaLimit = limit) {
  const lastMatch = (regex, upTo, after) => {
    regex.lastIndex = 0;
    let found = -1;
    let m;
    while ((m = regex.exec(text)) && m.index < upTo) {
      if (m.index >= MIN_CHUNK_CHARS) found = after ? m.index + 1 : m.index;
      if (m[0].length === 0) regex.lastIndex++; // zero-width lookahead match
    }
    return found;
  };
  const comma = lastMatch(PAUSE, commaLimit, true);
  if (comma > 0) return comma;
  const strong = lastMatch(STRONG_JOINER, limit, false);
  if (strong > 0) return strong;
  const weak = lastMatch(WEAK_JOINER, limit, false);
  if (weak > 0) return weak;
  // A plain space: the last good one in the window ("tell me about your name" breaks after
  // "name", not after "about"), else — with nothing better — the last space at all.
  for (let space = text.lastIndexOf(" ", limit); space >= MIN_CHUNK_CHARS; space = text.lastIndexOf(" ", space - 1)) {
    if (goodSpace(text, space)) return space;
  }
  const space = text.lastIndexOf(" ", limit);
  return space >= MIN_CHUNK_CHARS ? space : -1;
}

/**
 * How a chunk ended — which decides the pause after it (TTS in config.js):
 *   "sentence"  . ! ? … ۔ ؟ — a full pause
 *   "comma"     , ; : ، — a short one
 *   "joined"    cut between two words of one sentence — no pause at all: the next piece follows on
 * @param {string} chunk
 * @returns {"sentence"|"comma"|"joined"}
 */
export function chunkEnding(chunk) {
  const text = String(chunk ?? "").trimEnd().replace(/["'”’)\]]+$/, "");
  if (/[.!?…۔؟]$/.test(text)) return "sentence";
  if (/[,;:،]$/.test(text)) return "comma";
  return "joined";
}

/**
 * Strip what a voice must never read out (§9.2 — CHANNEL_STYLE.voice already forbids
 * all of it; this is the backstop for when the model ignores that): markdown emphasis
 * and headings, list bullets, code ticks, URLs. Collapses whitespace.
 *
 * @param {string} text
 */
export function sanitizeForSpeech(text) {
  return String(text ?? "")
    // A markdown link keeps its words — collapsed BEFORE bare URLs are stripped, or the
    // URL inside it would be removed first and leave "[words](" behind.
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Turns a stream of text deltas into speakable chunks, in order. */
export class SentenceChunker {
  /**
   * @param {{wholeSentences?: boolean}} [options] speak whole sentences only (cut one only past
   *   MAX_CHUNK_CHARS) — for a call whose speech is made slower than it plays (session.js)
   */
  constructor({ wholeSentences = false } = {}) {
    this.buffer = "";
    this.firstLength = null;
    this.sentChars = 0;
    this.wholeSentences = wholeSentences;
  }

  /** The most characters the NEXT chunk may have (see PROGRESSIVE CHUNK SIZES above). */
  limit() {
    if (this.wholeSentences) return MAX_CHUNK_CHARS;
    if (this.firstLength == null) return FIRST_CHUNK_CHARS;
    const allowed = Math.round(this.firstLength + CHUNK_GROWTH * this.sentChars);
    return Math.min(MAX_CHUNK_CHARS, Math.max(MIN_LATER_CHUNK_CHARS, allowed));
  }

  /**
   * Add a piece of the streamed reply.
   * @param {string} delta
   * @returns {string[]} chunks that became ready with this piece
   */
  push(delta) {
    this.buffer += String(delta ?? "");
    const out = [];

    for (;;) {
      const limit = this.limit();
      let sentence = firstSentenceEnd(this.buffer);

      // A tiny FIRST sentence ("Sure!") waits for the next one and goes out with it — alone it
      // is too short to cover the next chunk's synthesis (measured with npm run voice:gaps: "Sure!"
      // spoken alone before a long sentence left ~0.7 s of silence after it). The pair goes whole
      // when it fits; otherwise "Sure!" takes the START of the next sentence with it, cut below.
      let tinyFirst = false;
      if (sentence && this.firstLength == null && sentence.end < MIN_CHUNK_CHARS) {
        const second = firstSentenceEnd(this.buffer.slice(sentence.next));
        if (!second) {
          if (this.buffer.length <= Math.floor(limit * FIRST_CHUNK_COMMA_SLACK)) break; // the next sentence is still arriving
          tinyFirst = true;
          sentence = null;
        } else if (sentence.next + second.end <= limit) {
          sentence = { end: sentence.next + second.end, next: sentence.next + second.next };
        } else {
          tinyFirst = true;
          sentence = { end: sentence.next + second.end, next: sentence.next + second.next };
        }
      }

      // A whole sentence that fits: speak it as written.
      if (sentence && sentence.end <= limit && !tinyFirst) {
        this.emit(out, this.buffer.slice(0, sentence.end), sentence.next);
        continue;
      }

      // Too long for this chunk (or no sentence end yet and already past the limit):
      // break it where a speaker would pause. Until then, wait for more text. The first
      // chunk waits until it has seen as far as its comma slack reaches — mid-stream, the
      // comma it would prefer may simply not have arrived yet.
      const stretch = sentence ? this.buffer.slice(0, sentence.end) : this.buffer;
      const reach = this.firstLength == null && !this.wholeSentences ? Math.floor(limit * FIRST_CHUNK_COMMA_SLACK) : limit;
      if (stretch.length > reach || (sentence && stretch.length > limit)) {
        const at = breakPoint(stretch, limit, reach);
        if (at > 0) {
          this.emit(out, this.buffer.slice(0, at), at);
          continue;
        }
        // No break point at all (one enormous word): the whole sentence, if complete.
        if (sentence) {
          this.emit(out, this.buffer.slice(0, sentence.end), sentence.next);
          continue;
        }
      }
      break;
    }

    return out.map(sanitizeForSpeech).filter(Boolean);
  }

  emit(out, chunk, consumed) {
    out.push(chunk);
    this.buffer = this.buffer.slice(consumed).replace(/^\s+/, "");
    const length = chunk.trim().length;
    this.firstLength ??= length;
    this.sentChars += length;
  }

  /** Whatever is left once the stream has ended. */
  flush() {
    const rest = [];
    // The tail can still be longer than its limit — split it the same way.
    while (this.buffer.length > this.limit()) {
      const at = breakPoint(this.buffer, this.limit());
      if (at <= 0) break;
      this.emit(rest, this.buffer.slice(0, at), at);
    }
    if (this.buffer.trim()) this.emit(rest, this.buffer, this.buffer.length);
    return rest.map(sanitizeForSpeech).filter(Boolean);
  }
}
