import { twilioConfig } from "./twilio-config";
import { verifyTwilioSignature } from "./twilio-signature";

/** A real Twilio webhook is a few hundred bytes of form fields; anything much bigger is not one. */
const MAX_BODY_CHARS = 64 * 1024;

/**
 * Read a Twilio webhook and PROVE it came from Twilio (CLAUDE.md §6.30). The signature is checked
 * against the URL built from OUR configuration plus the path and query this request actually used —
 * never against the request's own Host header — and nothing is returned to the caller unless it
 * passes: a webhook that is not verified decides nothing.
 *
 * @param {Request & {nextUrl: URL}} request
 * @param {Record<string, string|undefined>} [env]
 * @returns {Promise<{ok: true, params: Record<string, string>} | {ok: false, status: 403 | 413 | 503}>}
 */
export async function readVerifiedTwilioRequest(request, env = process.env) {
  const config = twilioConfig(env);
  // Not set up: refuse everything rather than accept unsigned requests.
  if (!config.canAnswer) return { ok: false, status: 503 };

  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return { ok: false, status: 413 };

  const params = {};
  for (const [name, value] of new URLSearchParams(text)) {
    params[name] = name in params ? [].concat(params[name], value) : value;
  }

  const url = `${config.baseUrl}${request.nextUrl.pathname}${request.nextUrl.search}`;
  const valid = verifyTwilioSignature({ authToken: config.authToken, url, params, signature: request.headers.get("x-twilio-signature") });
  return valid ? { ok: true, params } : { ok: false, status: 403 };
}

/** @param {string} xml @returns {Response} */
export function twimlResponse(xml) {
  return new Response(xml, { status: 200, headers: { "content-type": "text/xml; charset=utf-8", "cache-control": "no-store" } });
}
