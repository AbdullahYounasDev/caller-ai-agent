import { NextResponse } from "next/server";
import { CAPABILITIES } from "@/lib/agent/capabilities/catalog";
import { checkInternalAuth } from "@/lib/auth/internal";
import { translator, resolveLocale } from "@/lib/i18n";

/**
 * GET /api/agent-config/catalog?locale=it
 *
 * The list of capabilities a business can switch on, so the partner's dashboard
 * can RENDER the toggles instead of hardcoding them. Add a capability to
 * lib/agent/capabilities/catalog.js plus its two strings to the locale files,
 * and it appears in his UI — translated — with no change on his side.
 *
 * `locale` is the UI LOCALE: the language the business owner is reading the
 * dashboard in, not the language their agent speaks to customers. Falls back to
 * the browser's Accept-Language, then English.
 *
 * `prompt` is deliberately NOT serialized: it's a function, it's our internal
 * prompt wording, and it has no business being shipped to a dashboard.
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const locale = resolveLocale({
      requested: request.nextUrl.searchParams.get("locale"),
      acceptLanguage: request.headers.get("accept-language"),
      enabled: undefined, // dashboard language isn't limited by a tenant's customer languages
      fallback: undefined,
    });
    const tr = translator(locale);

    const capabilities = CAPABILITIES.map((c) => ({
      id: c.id,
      label: tr(`capabilities:${c.id}.label`),
      description: tr(`capabilities:${c.id}.description`),
      channels: c.channels,
      // Channel names the business recognises ("Phone and calls"), not our
      // internal ids — the dashboard shouldn't have to know our vocabulary.
      channelLabels: Object.fromEntries(
        c.channels.map((ch) => [ch, tr(`common:channel.${ch}`)])
      ),
      defaultParams: c.params,
      // Tells the dashboard to show the "details collected, team confirms"
      // note instead of implying a live integration.
      requiresTool: c.requiresTool,
      setupNote: c.requiresTool ? tr("dashboard:capabilities.needsSetup") : null,
    }));

    return NextResponse.json({ locale, capabilities });
  } catch (err) {
    console.error("GET /api/agent-config/catalog failed:", err);
    return NextResponse.json(
      { error: err.message || "Something went wrong" },
      { status: 500 }
    );
  }
}
