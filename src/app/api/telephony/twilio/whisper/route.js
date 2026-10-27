import { whisperTwiml } from "@/lib/telephony/twilio-webhook";
import { readVerifiedTwilioRequest, twimlResponse } from "@/lib/telephony/twilio-request";
import { sayOnly } from "@/lib/telephony/twiml";

/**
 * WHAT THE PERSON WHO PICKS UP HEARS FIRST (CLAUDE.md §6.30) — a short summary of why the AI agent is
 * passing the caller to them, read before the two are connected.
 *
 *   POST /api/telephony/twilio/whisper?t=<signed state>
 *
 * Signature-verified like every Twilio webhook. If the state cannot be read the person just hears
 * that the call is from the assistant, and is connected.
 */
export async function POST(request) {
  try {
    const verified = await readVerifiedTwilioRequest(request);
    if (!verified.ok) return new Response(null, { status: verified.status });
    return twimlResponse(whisperTwiml(request.nextUrl.searchParams.get("t")));
  } catch (err) {
    console.error("POST /api/telephony/twilio/whisper failed:", err);
    return twimlResponse(sayOnly("Incoming call."));
  }
}
