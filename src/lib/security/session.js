import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Conversation session tokens.
 *
 * THE PROBLEM THIS SOLVES: the widget sends `conversationId` to continue a
 * thread. If that id were the only thing required, then anyone holding one
 * could read and write someone else's conversation — and conversation ids leak
 * in ordinary ways: browser history, shared screenshots, analytics payloads,
 * a support ticket where a customer pastes their console.
 *
 * So the server hands back a token alongside the id, and continuing a
 * conversation requires both. The token is an HMAC of the id under a server
 * secret: nothing is stored, nothing to look up, and a stolen id on its own is
 * useless.
 *
 * NOT a replacement for the tenant check. The widget route still verifies the
 * conversation belongs to the tenant behind the key — a valid token for
 * conversation X must not grant access through a different tenant's key.
 */

let cachedSecret;

function getSecret() {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.WIDGET_SESSION_SECRET;
  if (fromEnv) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    // Fail closed. Generating a random secret in production would "work" —
    // until a second instance starts with a different one and every customer
    // mid-conversation is silently logged out.
    throw new Error(
      "WIDGET_SESSION_SECRET is not set — required in production. Generate one with: openssl rand -hex 32"
    );
  }

  console.warn(
    "[session] WIDGET_SESSION_SECRET not set — using a random per-process secret. " +
      "Existing conversations will stop resuming on every dev-server restart."
  );
  cachedSecret = randomBytes(32).toString("hex");
  return cachedSecret;
}

/**
 * @param {string} conversationId
 * @returns {string} token to hand back to the client
 */
export function signConversation(conversationId) {
  return createHmac("sha256", getSecret()).update(conversationId).digest("hex");
}

/**
 * @param {string} conversationId
 * @param {string} token
 * @returns {boolean}
 */
export function verifyConversation(conversationId, token) {
  if (!conversationId || !token || typeof token !== "string") return false;

  const expected = signConversation(conversationId);
  if (expected.length !== token.length) return false;

  // Constant-time: a plain === on an HMAC leaks it byte by byte through timing,
  // which is exactly the kind of thing that's forgeable given enough attempts.
  return timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
