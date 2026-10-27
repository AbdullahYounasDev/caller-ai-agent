import { continueTransfer } from "@/lib/telephony/twilio-webhook";
import { readVerifiedTwilioRequest, twimlResponse } from "@/lib/telephony/twilio-request";
import { sayAndHangup } from "@/lib/telephony/twiml";
import { checkGatewayCapacity } from "@/lib/telephony/gateway-check";

/**
 * A TRANSFER'S DIAL ENDED (CLAUDE.md §6.30) — Twilio asks what to do next:
 *
 *   POST /api/telephony/twilio/transfer?t=<signed state>     (DialCallStatus: completed | no-answer | busy | failed…)
 *
 * Answered and finished → hang up. Not answered → ring the next person of the owner's list; nobody left →
 * the call goes BACK to the agent (a new stream with a resume ticket), or, if it cannot, a fixed line and goodbye. Signature-verified like every Twilio webhook;
 * the signed `t` carries the list, so no server memory is involved and any instance can answer.
 */
export async function POST(request) {
  try {
    const verified = await readVerifiedTwilioRequest(request);
    if (!verified.ok) return new Response(null, { status: verified.status });
    const { xml, outcome } = await continueTransfer({ token: request.nextUrl.searchParams.get("t"), params: verified.params, gateway: (tenantId) => checkGatewayCapacity({ tenantId }) });
    console.log(`[twilio] transfer: ${outcome.result}${outcome.status ? ` (${outcome.status})` : ""}${outcome.reason ? ` [${outcome.reason}]` : ""}`);
    return twimlResponse(xml);
  } catch (err) {
    console.error("POST /api/telephony/twilio/transfer failed:", err);
    return twimlResponse(sayAndHangup("Sorry, we could not connect your call. Goodbye."));
  }
}
