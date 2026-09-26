/**
 * HEADING-AWARE CHUNKING.
 *
 * The previous splitter took fixed 500-word windows with no regard for what it
 * was cutting. That is the standard first implementation and it fails in a
 * specific, expensive way: a price table split down the middle leaves half its
 * rows in a chunk that no longer says what they are prices FOR, and a refund
 * policy split mid-sentence produces two chunks that each read as a different
 * policy. Retrieval then confidently returns half a rule.
 *
 * This splitter works structurally instead:
 *
 *   1. Split the document into SECTIONS at headings.
 *   2. Keep each section whole while it fits.
 *   3. Only when a section is too big, split it at paragraph boundaries, then
 *      sentence boundaries, and only as a last resort mid-sentence.
 *   4. Carry the heading path onto every chunk it produced.
 *
 * Step 4 is what makes retrieval work on real documents. Under a heading
 * "Teeth whitening", the body often says "250 euros" and never repeats the
 * word "whitening". Embedded alone that chunk cannot match the question "how
 * much is whitening?" — the words simply are not in it. Prepending the heading
 * path puts them back.
 */

/** Target size in characters. Chosen to sit well inside the embedding model's
 *  window while leaving room for the heading prefix, and small enough that five
 *  retrieved chunks don't crowd out the conversation in the prompt. */
const TARGET_CHARS = 1400;
/** A chunk below this is usually a stray heading or a one-line fragment; it is
 *  merged into its neighbour rather than embedded on its own, because tiny
 *  chunks match everything weakly and crowd out real answers. */
const MIN_CHARS = 180;
/** Overlap carried between sub-chunks of the SAME section, so a sentence split
 *  across two chunks is still complete in one of them. */
const OVERLAP_CHARS = 150;

// A "label: value" line — "Phone: 123", "Email: info@...", "Source: https://…"
// — reads as short, title-cased and unpunctuated, which is exactly what the
// plain-text heading heuristic below looks for. Without this exclusion it
// gets classified as a heading; a heading's own text never enters a chunk's
// body (only its breadcrumb), so if nothing follows it before the next real
// heading, the line — a phone number, an email address, a source URL —
// vanishes from the document entirely rather than becoming a heading with an
// empty section. A colon with something other than whitespace after it is
// "label: value", not a title.
const LABEL_VALUE = /:\s*\S/;
// A URL or email on its own line reads the same way ("short, no terminal
// punctuation") and is exactly the kind of content this heuristic must not
// swallow as a heading.
const URL_OR_EMAIL = /https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+/i;

/**
 * Markdown headings (`## Pricing`) are unambiguous by syntax. Plain-text
 * headings — a short line in Title Case or ALL CAPS, with no terminal
 * punctuation — are not: business documents are full of short, capitalised,
 * unpunctuated lines that are NOT headings (a name, an address, a label and
 * its value), so this also requires the line to be followed by a blank line.
 * A "heading" glued directly to the text under it, like "Phone: 123" sitting
 * right above a paragraph with a blank line before but not after, is not a
 * structural break — it is content, and treating it as a heading either
 * strands it as an unquoted breadcrumb or, if nothing follows before the next
 * real heading, drops it from the document entirely.
 */
function detectHeading(line, nextLine) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const md = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (md) return { level: md[1].length, text: md[2].trim() };

  const nextIsBlank = nextLine === undefined || nextLine.trim() === "";
  if (!nextIsBlank) return null;

  // "PRICING", "Opening Hours", "3. Refunds" — but not a sentence, and not a
  // label/value or a bare URL/email either.
  if (
    trimmed.length <= 80 &&
    !/[.!?;:,]$/.test(trimmed) &&
    !LABEL_VALUE.test(trimmed) &&
    !URL_OR_EMAIL.test(trimmed)
  ) {
    const words = trimmed.split(/\s+/);
    if (words.length <= 9) {
      const isUpper = trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed);
      const isNumbered = /^\d+[.)]\s+\S/.test(trimmed);
      const isTitleish =
        words.length >= 1 &&
        words.filter((w) => /^[A-ZÀ-ɏ]/.test(w)).length >= Math.ceil(words.length / 2);

      if (isUpper) return { level: 1, text: trimmed };
      if (isNumbered) return { level: 2, text: trimmed.replace(/^\d+[.)]\s+/, "") };
      if (isTitleish) return { level: 2, text: trimmed };
    }
  }

  return null;
}

/** Split into sections, each carrying the heading path above it. */
function toSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  /** @type {{level:number,text:string}[]} */
  let stack = [];
  let buffer = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    buffer = [];
    if (body) sections.push({ heading: stack.map((h) => h.text).join(" > "), body });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = detectHeading(line, lines[i + 1]);
    if (heading) {
      flush();
      // Pop headings at the same or deeper level, so "Pricing > Whitening"
      // becomes "Pricing > Cleaning" rather than accumulating forever.
      stack = stack.filter((h) => h.level < heading.level);
      stack.push(heading);
    } else {
      buffer.push(line);
    }
  }
  flush();

  // A document with no detectable headings is one big section — correct, and
  // it degrades to paragraph splitting below rather than failing.
  if (!sections.length && text.trim()) {
    sections.push({ heading: "", body: text.trim() });
  }
  return sections;
}

/**
 * Hard character-count split — the LAST resort, used only on a single
 * sentence (or a run of text with no terminal punctuation at all) that alone
 * exceeds TARGET_CHARS. Nothing structural is left to split on at that point,
 * so this just cuts by length, carrying OVERLAP_CHARS backward into each next
 * piece so a phrase landing right on the cut point isn't orphaned in only one
 * of them.
 */
function hardSplit(text) {
  const pieces = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + TARGET_CHARS, text.length);
    pieces.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - OVERLAP_CHARS;
  }
  return pieces;
}

/** Split a too-large body at the cleanest boundary available. */
function splitBody(body) {
  if (body.length <= TARGET_CHARS) return [body];

  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim());
  const pieces = [];
  let current = "";

  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    // A single paragraph larger than the target (a long table, a wall of text)
    // gets split at sentence ends, and only mid-sentence if even that fails.
    if (paragraph.length > TARGET_CHARS) {
      push();
      const sentences = paragraph.match(/[^.!?\n]+[.!?]+[\s]*|[^.!?\n]+$/g) ?? [paragraph];
      let sentenceBuffer = "";
      for (const sentence of sentences) {
        // A SINGLE sentence bigger than the target — a run-on sentence, or a
        // block of text with no terminal punctuation at all, so the whole
        // thing matched as one "sentence" by the regex above. There is no
        // boundary left to split on, so this is the actual mid-sentence
        // fallback the comment above always described but the code never had:
        // whatever was accumulating flushes first, THIS sentence gets hard-split
        // by character count, and accumulation resumes clean after it.
        if (sentence.length > TARGET_CHARS) {
          if (sentenceBuffer.trim()) pieces.push(sentenceBuffer.trim());
          sentenceBuffer = "";
          pieces.push(...hardSplit(sentence));
          continue;
        }

        if (sentenceBuffer.length + sentence.length > TARGET_CHARS && sentenceBuffer) {
          pieces.push(sentenceBuffer.trim());
          // Carry the tail forward so a split sentence survives intact somewhere.
          sentenceBuffer = sentenceBuffer.slice(-OVERLAP_CHARS) + sentence;
        } else {
          sentenceBuffer += sentence;
        }
      }
      if (sentenceBuffer.trim()) pieces.push(sentenceBuffer.trim());
      continue;
    }

    if (current.length + paragraph.length + 2 > TARGET_CHARS) {
      // Carry a tail of the piece being pushed forward into the next one —
      // the sentence-split branch above already does this; ordinary
      // paragraph-to-paragraph accumulation did not, so a rule stated across
      // two consecutive paragraphs that happen to land in different chunks
      // was incomplete in both. This is the same fix, applied at the more
      // common boundary.
      const tail = current.slice(-OVERLAP_CHARS);
      push();
      current = tail;
    }
    current += (current ? "\n\n" : "") + paragraph;
  }
  push();

  return pieces;
}

/**
 * Merge runt pieces WITHIN one section, both directions.
 *
 * Backward (into the previous piece) handles the common case. But a runt that
 * is the section's OWN FIRST piece has no previous piece in this section to
 * fall into — chunkDocument used to leave it stranded alone unless the
 * PREVIOUS SECTION happened to share the same heading, which is the
 * exception, not the rule. Merging it forward, into the piece that follows,
 * means it always lands somewhere instead of becoming a fragment that matches
 * everything weakly.
 */
function mergeRunts(pieces) {
  const merged = [];
  for (const piece of pieces) {
    if (piece.length < MIN_CHARS && merged.length) {
      merged[merged.length - 1] += `\n\n${piece}`;
      continue;
    }
    merged.push(piece);
  }
  if (merged.length > 1 && merged[0].length < MIN_CHARS) {
    merged[1] = `${merged[0]}\n\n${merged[1]}`;
    merged.shift();
  }
  return merged;
}

/**
 * Chunk a document.
 *
 * @param {string} text
 * @returns {Array<{heading: string, content: string, embedText: string}>}
 *   `content` is what a human reads back; `embedText` is what gets embedded —
 *   the same text with its heading path prepended. They differ on purpose: the
 *   heading helps the vector match, but repeating it in the prompt would waste
 *   context and read oddly when the agent quotes the passage.
 */
export function chunkDocument(text) {
  const sections = toSections(String(text ?? ""));
  const out = [];

  for (const section of sections) {
    // Runts are merged WITHIN the section first (forward for a leading runt,
    // backward for any other) — see mergeRunts. Only a section that is
    // NOTHING BUT a single runt piece can still reach the loop below still
    // under MIN_CHARS, which is what the cross-section fallback handles.
    const pieces = mergeRunts(splitBody(section.body));

    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (!piece.trim()) continue;

      // Merge a remaining runt into the previous chunk OF THE SAME SECTION
      // rather than embedding a fragment that will match everything weakly.
      // Only possible for i === 0 now — mergeRunts already resolved every
      // other position within this section.
      const previous = out[out.length - 1];
      if (i === 0 && piece.length < MIN_CHARS && previous && previous.heading === section.heading) {
        previous.content += `\n\n${piece}`;
        previous.embedText = section.heading
          ? `${section.heading}\n\n${previous.content}`
          : previous.content;
        continue;
      }

      out.push({
        heading: section.heading,
        content: piece,
        embedText: section.heading ? `${section.heading}\n\n${piece}` : piece,
      });
    }
  }

  return out;
}
