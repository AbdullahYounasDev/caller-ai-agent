import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { describeTwilioSetup } from "@/lib/telephony/twilio-config";

/**
 * IS THE PHONE PATH SET UP? (CLAUDE.md §6.30) — for the console's Numbers tab and the partner's
 * dashboard: the address a Twilio number's "A call comes in" webhook must be pointed at, and what is
 * still missing in the deployment's environment. Names only — never a secret's value.
 *
 *   GET /api/telephony/twilio/setup  →  { ready, missing: ["TWILIO_AUTH_TOKEN", …], transfers, voiceWebhookUrl, streamUrl }
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    return NextResponse.json(describeTwilioSetup());
  } catch (err) {
    console.error("GET /api/telephony/twilio/setup failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
