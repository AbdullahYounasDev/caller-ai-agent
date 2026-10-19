/**
 * THE START MARKER — how a reply tells the engine "this customer wants a request taken".
 *
 * phrases.js recognises the usual ways of asking for an appointment or a callback, but
 * people in Pakistan ask in more ways than any list holds ("doctor sahib se milwa dein",
 * "Friday ko aa jaun?"). When the rules miss and the MODEL understands, it opens its reply
 * with `[[START appointment]]`; respond.js strips the marker before the customer — or the
 * text-to-speech voice — ever sees it, and starts the draft so the NEXT message is taken
 * as an answer. Without this a missed phrase would mean a customer who patiently gives a
 * name and a number to an agent that is not writing any of it down.
 *
 * Pure (tests/collect-marker.test.mjs).
 */

export const MARKER_EXAMPLE = "[[START code]]";

const MARKER = /^\s*\[\[\s*START\s+([a-z_]+)\s*\]\]\s*/i;

/**
 * A stream filter. Feed it the reply as it arrives, in chunks; it returns what is safe to
 * pass on NOW. A reply that does not begin with `[[` passes straight through with no delay
 * (the common case must not cost a call any latency); one that does is held back just long
 * enough to read the marker and drop it.
 *
 * @returns {{push(chunk: string): string, end(): string, readonly type: string|null}}
 */
export function createMarkerFilter() {
  let buffer = "";
  let state = "undecided"; // undecided → passthrough | holding → passthrough
  let type = null;

  function decide() {
    const trimmed = buffer.trimStart();
    if (!trimmed) return ""; // only whitespace so far
    if (!"[[".startsWith(trimmed.slice(0, 2)) && !trimmed.startsWith("[[")) {
      state = "passthrough";
      const out = buffer;
      buffer = "";
      return out;
    }
    if (trimmed.length < 2) return ""; // a lone "[": might still become "[["
    // It begins with "[[": wait for the closing "]]" (a real marker is short).
    const m = MARKER.exec(buffer);
    if (m) {
      type = m[1].toLowerCase();
      state = "passthrough";
      const out = buffer.slice(m[0].length);
      buffer = "";
      return out;
    }
    if (buffer.length > 60 || (buffer.includes("]]") && !MARKER.test(buffer))) {
      // Not a marker after all: give it back untouched.
      state = "passthrough";
      const out = buffer;
      buffer = "";
      return out;
    }
    return "";
  }

  return {
    push(chunk) {
      if (state === "passthrough") return chunk;
      buffer += chunk;
      return decide();
    },
    /** The reply ended: release anything still held. */
    end() {
      const out = state === "passthrough" ? "" : buffer;
      buffer = "";
      state = "passthrough";
      return out;
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
  const m = MARKER.exec(String(text ?? ""));
  return m ? { text: String(text).slice(m[0].length), type: m[1].toLowerCase() } : { text: String(text ?? ""), type: null };
}
