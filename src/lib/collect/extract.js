import { buildExtractionInstruction, buildExtractionInput } from "@/lib/agent/prompt";
import { choiceOptions } from "./config";
import { findPhoneInText, normalizeDigits, normalizeEmail, parseNumber, parseYesNo, matchOption } from "./validate";
import { looksLikeQuestion } from "./phrases";
import { mentionsOrderChange, parseOrderText } from "./order";

/** The rules' reading of an order, or null when the message names nothing on the menu. */
function orderFrom(def, text, ctx) {
  if (looksLikeQuestion(text)) return null;
  const read = parseOrderText(text, choiceOptions(ctx?.config, def));
  return read.lines.length || read.removed.length || read.ambiguous.length ? read : null;
}

/**
 * UNDERSTANDING WHAT THE CUSTOMER JUST GAVE US — two layers, cheapest first.
 *
 *   1. `heuristicAnswer`: the plain-rule reading. If we just asked "what is your phone
 *      number?" and the answer contains a number, that is the answer; if we asked for a
 *      name and the customer said "my name is Ahmed", it is "Ahmed". Free, instant, and it
 *      works when the model provider is down or out of quota (§8 limitation 3).
 *   2. `createExtractor`: ONE small model call that reads the whole message against the
 *      fields still missing and returns what it found — the way to handle "tomorrow after
 *      five", "I'm Ahmed, root canal please" (two fields in one sentence) and anything a
 *      rule cannot. Its answer is only ever a CANDIDATE: validate.js judges it, and a model
 *      that invents a phone number gets exactly as far as the format check.
 *
 * The extractor never speaks to the customer and never writes anything (§6.11). If it fails
 * for any reason the engine carries on with the heuristic reading and the turn is not lost.
 */

/** Strip the throat-clearing in front of a name: "my name is Ahmed", "میرا نام احمد ہے". */
function stripNameFrame(text) {
  return text
    .replace(/^(?:my name is|my name'?s|this is|i am|i'm|it is|it'?s|myself|mera naam|mera name|meraa naam|naam|main|میرا نام|نام|میں)\s+/iu, "")
    .replace(/\s+(?:hai|hain|speaking|here|ہے|ہیں)[.!۔]*$/iu, "")
    .replace(/[.!۔,،]+$/u, "")
    .trim();
}

const WORD_LIMIT = { name: 6, text: 12, longtext: 40 };

/**
 * What the message most plausibly gives for the one field we just asked about, by rules
 * alone. Returns the RAW value (validate.js normalises it) or null when the rules cannot tell.
 *
 * @param {object} def the field asked about
 * @param {string} message
 * @param {{config: object}} ctx
 * @returns {string|null}
 */
export function heuristicAnswer(def, message, ctx) {
  const text = String(message ?? "").trim();
  if (!text) return null;
  const words = text.split(/\s+/).length;

  switch (def.type) {
    case "phone": {
      const found = findPhoneInText(text);
      if (found) return found;
      // Something number-like that is not a phone number ("12 34") is still an ANSWER —
      // return it so validation can say why it was refused, instead of asking in silence.
      return normalizeDigits(text).replace(/\D/g, "").length >= 3 ? text : null;
    }
    case "email": {
      const direct = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/.exec(text);
      if (direct) return direct[0];
      return normalizeEmail(text).ok ? text : null;
    }
    case "number": {
      if (words > 6) return null;
      const n = parseNumber(text);
      return n === null ? null : String(n);
    }
    case "yesno":
      return parseYesNo(text);
    case "choice": {
      const options = choiceOptions(ctx.config, def);
      const option = matchOption(text, options);
      if (option) return option.id;
      return options.length === 0 && words <= 8 && !looksLikeQuestion(text) ? text : null;
    }
    case "datetime":
      return null; // "kal shaam" needs the clock and the opening hours: the extractor's job
    case "items":
      // Dishes the menu names, with what was said about them (order.js). A dish NOT on the menu
      // is not found here; the extractor names it and validation refuses it.
      return orderFrom(def, text, ctx);
    default: {
      // A free-text answer to the question we just asked — unless the customer asked a question back.
      if (looksLikeQuestion(text)) return null;
      const value = def.id === "name" ? stripNameFrame(text) : text;
      const limit = WORD_LIMIT[def.id === "name" ? "name" : def.type === "longtext" ? "longtext" : "text"];
      if (!value || value.split(/\s+/).length > limit) return null;
      if (def.id === "name" && /\d/.test(value)) return null;
      return value;
    }
  }
}

/**
 * A value the customer volunteered for a field we were NOT asking about, found by rules.
 * Only the shapes that cannot be mistaken for anything else: a phone number, an email, and
 * dishes from the business's own menu ("I'd like to order two chicken biryanis"). An order
 * already taken is only changed by a message that SAYS it changes it ("add a coke", "no raita")
 * — "House 5, Biryani Street" must never add a biryani.
 *
 * @param {object} def
 * @param {string} message
 * @param {{config?: object}} [ctx]
 * @param {{filled?: boolean}} [options] the field already has a value
 * @returns {unknown|null}
 */
export function volunteeredValue(def, message, ctx, { filled = false } = {}) {
  const text = String(message ?? "");
  if (def.type === "phone") return findPhoneInText(text);
  if (def.type === "email") return /[^\s@]+@[^\s@]+\.[^\s@]{2,}/.exec(text)?.[0] ?? null;
  if (def.type === "items") return !filled || mentionsOrderChange(text) ? orderFrom(def, text, ctx) : null;
  // A FIXED short list (pickup / delivery) is distinctive enough to notice unasked — "Ahmed, and
  // it's for delivery". Never from a question ("how long does delivery take?"), and an answer
  // already given changes only when the caller says so ("actually I'll pick it up instead").
  if (def.type === "choice" && def.options?.length && !def.source) {
    if (looksLikeQuestion(text) || (filled && !SWITCHING.test(text))) return null;
    return matchOption(text, def.options)?.id ?? null;
  }
  return null;
}

const SWITCHING = /(?<![\p{L}\p{M}])(?:instead|actually|change|switch|rather|make it|ki jagah|ke bajaye|balke|کی جگہ|کے بجائے|بلکہ)(?![\p{L}\p{M}])/iu;

/**
 * Parse the extractor's reply into `{values, date, time}` — tolerant of the things models
 * wrap around JSON (code fences, a sentence before it), strict about what it keeps: only
 * listed field ids, only strings and numbers, nothing that says "null" or "unknown".
 *
 * @param {string} raw
 * @param {string[]} allowedIds
 * @returns {{values: Record<string, string>, date: string|null, time: string|null}|null} null when unusable
 */
export function parseExtraction(raw, allowedIds) {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const usable = (v) => (typeof v === "string" || typeof v === "number") && !/^\s*(null|none|unknown|n\/a|not provided|-)?\s*$/i.test(String(v));
  const values = {};
  const given = data.values && typeof data.values === "object" ? data.values : {};
  for (const id of allowedIds) {
    if (usable(given[id])) values[id] = String(given[id]).trim();
  }
  const date = typeof data.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data.date.trim()) ? data.date.trim() : null;
  const time = typeof data.time === "string" && /^\d{2}:\d{2}$/.test(data.time.trim()) ? data.time.trim() : null;
  return { values, date, time };
}

/**
 * The model-backed extractor.
 *
 * @param {object} args
 * @param {(args: {systemInstruction: string, history: Array, timeoutMs: number}) => Promise<string>} args.generate
 *   llm.js generateExtraction — injected so tests never touch a provider
 * @param {number} [args.timeoutMs]
 * @returns {(request: object) => Promise<{values: object, date: string|null, time: string|null}>}
 */
export function createExtractor({ generate, timeoutMs = 4000 }) {
  return async function extract({ fields, asking, message, history, nowMs, timezone, hours, language, config }) {
    const systemInstruction = buildExtractionInstruction({ fields, config, nowMs, timezone, hours, language });
    const input = buildExtractionInput({ history, message, asking });
    const raw = await generate({
      systemInstruction,
      history: [{ role: "user", parts: [{ text: input }] }],
      timeoutMs,
    });
    const parsed = parseExtraction(raw, fields.map((f) => f.id));
    if (!parsed) throw new Error("unusable extraction");
    return parsed;
  };
}
