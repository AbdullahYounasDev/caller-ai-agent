import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * SMALL SIGNED TOKENS for the phone path — what lets a URL we hand to Twilio carry state
 * (which people are still to be tried on a transfer, the summary to say to them) without a
 * database and without anyone being able to change it. HMAC-SHA256 with the same shared secret as
 * the voice tickets (voice/ticket.js), a kind so one kind of token is never accepted as another,
 * and an expiry. Pure (tests/twilio-telephony.test.mjs).
 */

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const sign = (payload, secret) => createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * @param {string} kind    what the token is for ("xfer")
 * @param {object} claims  JSON-serialisable
 * @param {{secret: string, ttlMs: number, now?: number}} options
 * @returns {string}
 */
export function signToken(kind, claims, { secret, ttlMs, now = Date.now() }) {
  const payload = b64url(JSON.stringify({ k: kind, e: now + ttlMs, ...claims }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * @param {string} kind
 * @param {unknown} token
 * @param {{secret: string, now?: number}} options
 * @returns {object|null} the claims, or null when the token is malformed, forged, expired or of another kind
 */
export function verifyToken(kind, token, { secret, now = Date.now() }) {
  const [payload, signature, extra] = String(token ?? "").split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims?.k === kind && typeof claims.e === "number" && claims.e >= now ? claims : null;
  } catch {
    return null;
  }
}
