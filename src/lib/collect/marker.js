/**
 * THE START MARKER — how a reply tells the engine "this customer wants a request taken".
 *
 * phrases.js recognises the usual ways of asking for an appointment or a callback, but
 * people in Pakistan ask in more ways than any list holds ("doctor sahib se milwa dein",
 * "Friday ko aa jaun?"). When the rules miss and the MODEL understands, it writes
 * `[[START appointment]]` in its reply; respond.js removes the marker before the customer —
 * or the text-to-speech voice — ever sees it, and starts the draft so the NEXT message is
 * taken as an answer. Without this a missed phrase would mean a customer who patiently gives
 * a name and a number to an agent that is not writing any of it down.
 *
 * ── WHERE A MARKER MAY APPEAR ─────────────────────────────────────────────
 * The prompt asks for it at the very start, but a model does not always obey: a real call
 * read aloud "…on top of the treatment cost. [[START code]]May I have your name, please?" —
 * the marker mid-reply, with the placeholder word "code" copied from the instruction. So the
 * filter now removes a marker ANYWHERE in the reply, however it is split across stream
 * chunks, and tolerates a single-bracket variant. What the type word means is NOT decided
 * here: whoever uses `type` checks it against the request types the business really has
 * (an unknown word such as "code" starts nothing).
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Pure (tests/collect-marker.test.mjs).
 */

/** The longest a real marker can be: "[[START " + a code + "]]". Anything longer is just text. */
const MAX_MARKER_CHARS = 48;

/** A whole marker. The code word is captured; it may be anything letters-and-underscores. */
const MARKER = /^(?:\[\[\s*START\b\s*([A-Za-z_]*)\s*\]\]|\[\s*START\b\s*([A-Za-z_]*)\s*\])/i;

/** Could `text` (which starts with "[") still grow into a marker? Used to hold a split chunk. */
function couldBecomeMarker(text) {
  if (text.length > MAX_MARKER_CHARS) return false;
  // "[", "[[", "[[ ST", "[[START appoint" … — a prefix of the marker grammar, no "]" seen yet.
  return /^\[\[?\s*(?:S(?:T(?:A(?:R(?:T)?)?)?)?|START\b[^\]]*\]?)?$/i.test(text);
}

/**
 * A stream filter. Feed it the reply as it arrives, in chunks; it returns what is safe to
 * pass on NOW. Ordinary text passes straight through with no delay (the common case must
 * not cost a call any latency); only a "[" that might begin a marker is held, for as long
 * as it takes to tell.
 *
 * @returns {{push(chunk: string): string, end(): string, readonly type: string|null}}
 */
export function createMarkerFilter() {
  let pending = "";
  let type = null;
  // After a marker is dropped, one space on either side of it would double up.
  let trimNext = true; // the very start of the reply has no leading whitespace to keep

  const emit = (text) => {
    if (!text) return "";
    let out = text;
    if (trimNext) {
      out = out.replace(/^\s+/, "");
      if (out) trimNext = false;
    }
    return out;
  };

  function drain(final) {
    let text = pending;
    pending = "";
    let out = "";
    for (;;) {
      const at = text.indexOf("[");
      if (at === -1) {
        out += emit(text);
        return out;
      }
      out += emit(text.slice(0, at));
      text = text.slice(at);

      const marker = MARKER.exec(text);
      if (marker) {
        const code = marker[1] ?? marker[2];
        type ??= code ? code.toLowerCase() : null;
        text = text.slice(marker[0].length);
        trimNext = true;
        // "…cost. [[START x]] May I…": drop the space that is now doubled.
        if (/\s$/.test(out)) trimNext = true;
        continue;
      }
      if (!final && couldBecomeMarker(text)) {
        pending = text; // wait for more
        return out;
      }
      // Not a marker: the bracket is ordinary text.
      out += emit(text[0]);
      text = text.slice(1);
    }
  }

  return {
    push(chunk) {
      pending += chunk;
      return drain(false);
    },
    /** The reply ended: release anything still held (a lone "[" in plain text, say). */
    end() {
      return drain(true);
    },
    get type() {
      return type;
    },
  };
}

/**
 * The same, for a reply that is already whole.
 * @param {string} text
 * @returns {{text: string, type: string|null}}
 */
export function stripMarker(text) {
  const filter = createMarkerFilter();
  const out = filter.push(String(text ?? "")) + filter.end();
  return { text: out, type: filter.type };
}

/** The marker the prompt shows the model for a request type — always a REAL code, never a placeholder. */
export function markerFor(type) {
  return `[[START ${type}]]`;
}
