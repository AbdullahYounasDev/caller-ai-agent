/**
 * TWIML — the small XML documents our webhooks answer Twilio with (CLAUDE.md §6.30). Pure.
 * Every value that reaches an attribute or a text node is escaped: a caller-controlled string
 * (a name in a summary) must never be able to add a verb to the call.
 */

const escape = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const wrap = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** Say a line, then end the call. Twilio's own voice reads it, so it is plain English. */
export function sayAndHangup(text) {
  return wrap(`<Say language="en-US">${escape(text)}</Say><Hangup/>`);
}

/** Say a line to the person whose phone is ringing, before they are connected (a "whisper"). */
export function sayOnly(text) {
  return wrap(`<Say language="en-US">${escape(text)}</Say>`);
}

/** Nothing more to do: let the call end. */
export function hangup() {
  return wrap("<Hangup/>");
}

/**
 * Hand the call's audio to the voice gateway over a Media Stream. `parameters` reach the gateway in
 * the stream's start message (customParameters) — the signed ticket travels there.
 *
 * @param {{url: string, parameters?: Record<string, string>}} args
 */
export function connectStream({ url, parameters = {} }) {
  const params = Object.entries(parameters).map(([name, value]) => `<Parameter name="${escape(name)}" value="${escape(value)}"/>`).join("");
  return wrap(`<Connect><Stream url="${escape(url)}">${params}</Stream></Connect><Hangup/>`);
}

/**
 * Ring one number and bridge. `action` is asked what to do when the dial ends (answered and
 * finished, or nobody picked up); `whisperUrl` is played to the callee when they answer, before the
 * two are connected.
 *
 * @param {{number: string, timeoutSec: number, action: string, whisperUrl?: string}} args
 */
export function dialNumber({ number, timeoutSec, action, whisperUrl }) {
  const target = whisperUrl ? `<Number url="${escape(whisperUrl)}">${escape(number)}</Number>` : `<Number>${escape(number)}</Number>`;
  return wrap(`<Dial timeout="${Math.round(timeoutSec)}" action="${escape(action)}" answerOnBridge="true">${target}</Dial>`);
}
