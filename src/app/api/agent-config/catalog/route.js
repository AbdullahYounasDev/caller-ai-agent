import { NextResponse } from "next/server";
import { CAPABILITIES } from "@/lib/agent/capabilities/catalog";
import { checkInternalAuth } from "@/lib/auth/internal";

/**
 * GET /api/agent-config/catalog
 *
 * The list of capabilities a business can switch on, so the partner's dashboard
 * can RENDER the toggles instead of hardcoding them. Add a capability to
 * lib/agent/capabilities/catalog.js and it appears in his UI with no change on
 * his side — that's the whole reason this endpoint exists.
 *
 * `prompt` is deliberately NOT serialized: it's a function, it's our internal
 * prompt wording, and it has no business being shipped to a dashboard.
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const capabilities = CAPABILITIES.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      channels: c.channels,
      defaultParams: c.params,
      // Tells the dashboard to show a "coming soon" / "details collected, team
      // confirms manually" note instead of implying a live integration.
      requiresTool: c.requiresTool,
    }));

    return NextResponse.json({ capabilities });
  } catch (err) {
    console.error("GET /api/agent-config/catalog failed:", err);
    return NextResponse.json(
      { error: err.message || "Something went wrong" },
      { status: 500 }
    );
  }
}
