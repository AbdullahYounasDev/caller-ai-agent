import { NextResponse } from "next/server";
import {
  LOCALE_META,
  getCatalog,
  resolveLocale,
  dirFor,
  isSupportedLocale,
} from "@/lib/i18n";

/**
 * THE INTERFACE-LANGUAGE ENDPOINT. Public on purpose — it returns nothing but
 * UI labels, and the partner's dashboard needs them before anyone has logged
 * in or been identified.
 *
 *   GET /api/locales
 *       → the languages the system speaks, for a language switcher
 *
 *   GET /api/locales?locale=ar
 *       → every string for that language, so a frontend renders its WHOLE
 *         interface from one request instead of asking key by key
 *
 *   GET /api/locales?locale=it&ns=dashboard,common
 *       → just those namespaces, for a client that needs only part of the UI
 *
 * This is what makes "pick a language and the entire system changes" true
 * rather than aspirational: the frontend holds no English of its own, so there
 * is nothing left to forget to translate.
 */
export async function GET(request) {
  try {
    const requested = request.nextUrl.searchParams.get("locale");

    // No locale asked for: just advertise what's available. `dir` is included
    // so a switcher can flip its own layout without hardcoding which languages
    // are right-to-left.
    if (!requested) {
      return NextResponse.json({ locales: LOCALE_META });
    }

    if (!isSupportedLocale(requested)) {
      // Resolve rather than 404 — a browser asking for a language we don't have
      // should get a usable interface, not an error page.
      const fallback = resolveLocale({
        acceptLanguage: request.headers.get("accept-language"),
        enabled: undefined,
        fallback: undefined,
      });
      return NextResponse.json({
        locale: fallback,
        dir: dirFor(fallback),
        requested,
        fellBack: true,
        locales: LOCALE_META,
        messages: getCatalog(fallback),
      });
    }

    const ns = request.nextUrl.searchParams.get("ns");
    const namespaces = ns
      ? ns.split(",").map((n) => n.trim()).filter(Boolean)
      : undefined;

    return NextResponse.json({
      locale: requested,
      dir: dirFor(requested),
      locales: LOCALE_META,
      messages: getCatalog(requested, namespaces),
    });
  } catch (err) {
    console.error("GET /api/locales failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
