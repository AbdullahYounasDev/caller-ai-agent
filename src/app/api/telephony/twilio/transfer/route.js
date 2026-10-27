import { continueTransfer } from "@/lib/telephony/twilio-webhook";
import { readVerifiedTwilioRequest, twimlResponse } from "@/lib/telephony/twilio-request";
import { sayAndHangup } from "@/lib/telephony/twiml";

/**
 * A TRANSFER'S DIAL ENDED (CLAUDE.md §6.30) — Twilio asks what to do next:
 *
 *   POST /api/telephony/twilio/transfer?t=<signed state>     (DialCallStatus: completed | no-answer | busy | failed…)
 *
 * Answered and finished → hang up. Not answered → ring the next person of the owner's list, or say a
 * fixed line and hang up when there is nobody left. Signature-verified like every Twilio webhook;
 * the signed `t` carries the list, so no server memory is involved and any instance can answer.
 */
export async function POST(request) {
  try {
    const verified = await readVerifiedTwilioRequest(request);
    if (!verified.ok) return new Response(null, { status: verified.status });
    const { xml, outcome } = continueTransfer({ token: request.nextUrl.searchParams.get("t"), params: verified.params });
    console.log(`[twilio] transfer: ${outcome.result}${outcome.status ? ` (${outcome.status})` : ""}`);
    return twimlResponse(xml);
  } catch (err) {
    console.error("POST /api/telephony/twilio/transfer failed:", err);
    return twimlResponse(sayAndHangup("Sorry, we could not connect your call. Goodbye."));
  }
}
