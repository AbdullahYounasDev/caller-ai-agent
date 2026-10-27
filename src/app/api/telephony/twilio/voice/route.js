import { resolveDialledNumber } from "@/lib/tenant/registry";
import { hit } from "@/lib/security/rate-limit";
import { answerInboundCall, INBOUND_LIMIT } from "@/lib/telephony/twilio-webhook";
import { readVerifiedTwilioRequest, twimlResponse } from "@/lib/telephony/twilio-request";
import { sayAndHangup } from "@/lib/telephony/twiml";
import { checkGatewayCapacity } from "@/lib/telephony/gateway-check";

/**
 * A CALL CAME IN — the URL a business's Twilio number is pointed at (CLAUDE.md §6.30):
 *
 *   POST /api/telephony/twilio/voice        (Twilio, form-encoded: To, From, CallSid, …)
 *
 * NOT guarded by INTERNAL_API_KEY — Twilio cannot send it. The trust is Twilio's request SIGNATURE
 * (telephony/twilio-request.js): unverified, the request decides nothing. Verified, the dialled
 * number picks the business and agent (registry.js resolveDialledNumber, §6.29 — never anything the
 * caller supplies) and the answer is TwiML: a media stream to the voice gateway with a signed
 * one-minute ticket, or a plain refusal line. Always a 200 with TwiML once verified: any other
 * status makes Twilio say its own "application error" to the caller.
 */
export async function POST(request) {
  try {
    const verified = await readVerifiedTwilioRequest(request);
    if (!verified.ok) return new Response(null, { status: verified.status });

    const { xml, outcome } = await answerInboundCall({
      params: verified.params,
      resolve: (dialled) => resolveDialledNumber(dialled),
      limit: (key) => hit({ key, ...INBOUND_LIMIT }),
      gateway: (tenantId) => checkGatewayCapacity({ tenantId }),
    });
    // The result and the reason, never the numbers (they are the callers' and the business's to keep).
    console.log(`[twilio] inbound call: ${outcome.result}${outcome.reason ? ` (${outcome.reason})` : ""}${outcome.tenantId ? ` tenant ${outcome.tenantId}` : ""}`);
    return twimlResponse(xml);
  } catch (err) {
    console.error("POST /api/telephony/twilio/voice failed:", err);
    return twimlResponse(sayAndHangup("Sorry, we are having trouble taking your call right now. Please try again in a moment. Goodbye."));
  }
}
