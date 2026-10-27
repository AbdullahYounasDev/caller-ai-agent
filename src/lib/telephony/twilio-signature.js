import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * TWILIO'S REQUEST SIGNATURE — how the webhook knows a request really came from Twilio
 * (CLAUDE.md §6.30). Without it anyone could POST "a call to number X" and open calls on a
 * business's agent, or forge the "who is calling" that lands in its call log.
 *
 * Twilio signs every webhook it sends: HMAC-SHA1, keyed with the account's Auth Token, over
 * the FULL URL it requested followed by every POST parameter as `name` + `value`, sorted by
 * name; base64, in the `X-Twilio-Signature` header. We recompute it from the URL WE configured
 * (never from request headers, which a proxy or a caller can bend) and compare in constant time.
 *
 * Pure (tests/twilio-signature.test.mjs; the published example from Twilio's docs is pinned there).
 */

/**
 * @param {object} args
 * @param {string} args.authToken
 * @param {string} args.url     the full URL Twilio requested, query string included
 * @param {Record<string, string|string[]>} args.params  the POST body as name → value(s)
 * @returns {string} base64
 */
export function twilioSignature({ authToken, url, params }) {
  let data = url;
  for (const name of Object.keys(params ?? {}).sort()) {
    const value = params[name];
    // A name sent twice contributes each value, sorted — the same rule Twilio's own libraries use.
    for (const v of Array.isArray(value) ? [...value].sort() : [value]) data += name + v;
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * @param {object} args  as twilioSignature, plus
 * @param {string|null|undefined} args.signature  the X-Twilio-Signature header
 * @returns {boolean}
 */
export function verifyTwilioSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  const expected = Buffer.from(twilioSignature({ authToken, url, params }));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && timingSafeEqual(expected, given);
}
