import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { translator } from "@/lib/i18n";
import { listRecords } from "@/lib/standins/records";

/**
 * THE REQUESTS THE AGENT HAS TAKEN — appointments and callbacks waiting for a person.
 *
 *   GET /api/records?tenantId=…[&status=requested][&type=appointment][&take=50][&skip=0]
 *
 * Newest first, plus the number in each status for the badges. Reading a suspended
 * tenant's own data is not what requireServiceableTenant guards against (§6.18), so — like
 * every GET — this does not call it.
 *
 * ⚠ Backed by src/lib/standins/ — the backend owns these in production
 * (docs/handoff-to-backend.md).
 */
export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const params = request.nextUrl.searchParams;
    const tenantId = params.get("tenantId");
    const locale = await uiLocaleFor(request, tenantId);
    const tr = translator(locale);
    if (!tenantId) return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });

    const number = (key, fallback) => {
      const n = Number.parseInt(params.get(key) ?? "", 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const result = await listRecords(tenantId, {
      status: params.get("status") || undefined,
      type: params.get("type") || undefined,
      take: number("take", 50),
      skip: number("skip", 0),
    });
    return NextResponse.json({ ...result, locale });
  } catch (err) {
    console.error("GET /api/records failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}
