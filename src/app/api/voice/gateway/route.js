import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { gatewayUrls } from "@/lib/voice/gateway-url";

/**
 * WHERE THE VOICE GATEWAY IS — for the console's voice picker.
 *
 *   GET /api/voice/gateway → { healthUrl, previewUrl }
 *
 * The picker needs the gateway's address to play voice previews and to learn which
 * voices are installed, without starting a call (which would spend a session ticket).
 * Internal-auth guarded like every route; it returns addresses only.
 */
export async function GET(request) {
  const auth = checkInternalAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { healthUrl, previewUrl } = gatewayUrls(request);
  return NextResponse.json({ healthUrl, previewUrl });
}
