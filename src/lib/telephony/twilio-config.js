import { gatewayPort } from "@/lib/voice/config";

/**
 * WHERE TWILIO AND WE FIND EACH OTHER — read from the environment, never from a request (a request
 * header can be bent by a proxy or a caller; the URL Twilio signed is the one WE gave it).
 *
 *   TWILIO_AUTH_TOKEN         verifies every webhook's signature, and places transfers (REST)
 *   TWILIO_ACCOUNT_SID        places transfers (REST)
 *   TWILIO_WEBHOOK_BASE_URL   the public https origin of THIS app as Twilio reaches it
 *                             (falls back to PUBLIC_APP_URL); Twilio's number is pointed at
 *                             <base>/api/telephony/twilio/voice
 *   VOICE_GATEWAY_PUBLIC_URL  the public address of the voice gateway; the call's audio goes to
 *                             wss://…/twilio (the same variable the console's browser calls use)
 *
 * The Twilio account itself — buying numbers, billing — is the backend's (§4); only these four
 * settings are the engine's, and they are secrets/addresses of the DEPLOYMENT, not per business.
 * Pure (tests/twilio-telephony.test.mjs).
 */

export const WEBHOOK_PATHS = Object.freeze({
  voice: "/api/telephony/twilio/voice",
  transfer: "/api/telephony/twilio/transfer",
  whisper: "/api/telephony/twilio/whisper",
});

const trimUrl = (value) => String(value ?? "").trim().replace(/\/+$/, "");

/**
 * @param {Record<string, string|undefined>} [env]
 */
export function twilioConfig(env = process.env) {
  const baseUrl = trimUrl(env.TWILIO_WEBHOOK_BASE_URL) || trimUrl(env.PUBLIC_APP_URL);
  const gateway = trimUrl(env.VOICE_GATEWAY_PUBLIC_URL);
  const authToken = env.TWILIO_AUTH_TOKEN?.trim() || null;
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim() || null;
  return {
    authToken,
    accountSid,
    baseUrl: baseUrl || null,
    /** Where Twilio opens the call's audio stream; null until the gateway has a public address. */
    streamUrl: gateway ? `${gateway.replace(/^http/, "ws")}/twilio` : null,
    gatewayPort: gatewayPort(env),
    /** Webhooks can be verified. */
    canAnswer: Boolean(authToken && baseUrl),
    /** Transfers can be placed. */
    canTransfer: Boolean(authToken && accountSid && baseUrl),
    voiceWebhookUrl: baseUrl ? `${baseUrl}${WEBHOOK_PATHS.voice}` : null,
  };
}

/** What the console shows so the right address can be pasted into the Twilio number's settings. */
export function describeTwilioSetup(env = process.env) {
  const c = twilioConfig(env);
  const problems = [];
  if (!c.authToken) problems.push("TWILIO_AUTH_TOKEN");
  if (!c.baseUrl) problems.push("TWILIO_WEBHOOK_BASE_URL");
  if (!c.streamUrl) problems.push("VOICE_GATEWAY_PUBLIC_URL");
  return {
    ready: problems.length === 0,
    missing: problems,
    transfers: c.canTransfer,
    voiceWebhookUrl: c.voiceWebhookUrl,
    streamUrl: c.streamUrl,
  };
}
