/**
 * THE BUSINESS SUMMARY'S RULES — pure, shared by the server and the console (CLAUDE.md §6.20).
 *
 * The owner picks the documents that describe the business (a company overview, an "about us"),
 * the AI writes a short summary of them, the owner reads it, edits it and saves it into the
 * agent's profile — where it is ALWAYS in the prompt, so "who are you?" and "what do you do?"
 * are answered at once, with no search. Everything specific — prices above all — stays in the
 * documents and is looked up when asked, because a price written into a summary goes stale the
 * day the price list changes, and the agent would then quote the old one with confidence.
 *
 * So a summary holds GENERAL facts only, and prices are kept out twice: sentences with a price in
 * them are removed from the AI's draft (the owner is shown what was removed), and a summary with a
 * price in it is refused on save, whoever wrote it.
 *
 * Tests: tests/summary-rules.test.mjs.
 */

export const SUMMARY_MAX_CHARS = 1200;
export const SUMMARY_MAX_DOCUMENTS = 10;

const CURRENCY = "(?:rs\\.?|pkr|inr|usd|eur|gbp|aed|sar|\\$|€|£|rupees?|euros?|dollars?|pounds?|روپے|روپیہ|روپئے)";
const AMOUNT = "\\d[\\d,.\\s]*(?:k|thousand|hundred|lakh|ہزار|سو)?";
/**
 * A price: a currency next to a number in digits ("Rs 1,500", "€149", "1500 rupees", "1500 روپے"),
 * a number "per month" / "/month", or a percentage off. A price written out in words ("fifteen
 * hundred rupees") is not caught — the AI is told to leave prices out, and this is the net behind it.
 */
const PRICE = new RegExp(
  [
    `${CURRENCY}\\s*${AMOUNT}`,
    `${AMOUNT}\\s*${CURRENCY}(?![\\p{L}])`,
    `\\d[\\d,.]*\\s*(?:/|per\\s+)\\s*(?:month|mo|year|yr|week|day|hour|person|plate|head|user|seat|session)`,
    `\\d[\\d,.]*\\s*%\\s*(?:off|discount)`,
  ].join("|"),
  "giu"
);

/**
 * Every price-like mention in a text, as written.
 * @param {string} text
 * @returns {string[]}
 */
export function priceMentions(text) {
  return [...String(text ?? "").matchAll(PRICE)].map((m) => m[0].replace(/[\s.,]+$/, "")).filter(Boolean);
}

/** Sentences, keeping their end marks (Latin and Urdu). */
const sentencesOf = (text) => String(text ?? "").match(/[^.!?۔؟\n]+[.!?۔؟]*\s*/g) ?? [];

/**
 * The AI's draft without the sentences that carry a price; what was taken out is returned so the
 * owner sees it (and can put the fact in a document instead).
 * @param {string} text
 * @returns {{text: string, removed: string[]}}
 */
export function stripPrices(text) {
  const removed = [];
  const kept = [];
  for (const sentence of sentencesOf(text)) {
    if (priceMentions(sentence).length) removed.push(sentence.trim());
    else kept.push(sentence);
  }
  return { text: kept.join("").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/**
 * A summary in its stored form: markdown and list marks removed (the model is told not to use
 * them, and the text is spoken on calls), spaces tidied, paragraphs kept.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeSummary(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_#`]+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A draft cut to the limit at the end of a sentence, never mid-word.
 * @param {string} text
 */
export function clipSummary(text) {
  if (text.length <= SUMMARY_MAX_CHARS) return text;
  const cut = text.slice(0, SUMMARY_MAX_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("۔"), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  return (end > SUMMARY_MAX_CHARS / 2 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" "))).trim();
}

/**
 * What is wrong with a summary being saved, as translatable codes (validation:summary.*).
 * @param {unknown} text
 * @returns {Array<{code: string, vars?: object}>}
 */
export function summaryProblems(text) {
  if (text === null || text === undefined || text === "") return [];
  if (typeof text !== "string") return [{ code: "invalid" }];
  const clean = normalizeSummary(text);
  const problems = [];
  if (clean.length > SUMMARY_MAX_CHARS) problems.push({ code: "tooLong", vars: { max: SUMMARY_MAX_CHARS } });
  const prices = priceMentions(clean);
  if (prices.length) problems.push({ code: "hasPrice", vars: { price: prices[0] } });
  return problems;
}
