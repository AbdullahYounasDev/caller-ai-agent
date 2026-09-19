import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import {
  createWidgetKey,
  listWidgetKeys,
  revokeWidgetKey,
  setAllowedOrigins,
  normalizeOrigin,
} from "@/lib/tenant/registry";

/**
 * Widget key provisioning — server-to-server, for the partner's dashboard.
 *
 *   GET    /api/widget-keys?tenantId=…            list a tenant's keys
 *   POST   /api/widget-keys?tenantId=…            create one  { allowedOrigins?, label? }
 *   PATCH  /api/widget-keys?tenantId=…            update origins { keyId, allowedOrigins }
 *   DELETE /api/widget-keys?tenantId=…&keyId=…    revoke one
 *
 * His onboarding flow calls POST once per tenant and shows the business the
 * embed snippet. Everything is scoped by tenantId inside lib/tenant/registry.js
 * so one tenant can never touch another's key by guessing a uuid.
 */

export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    return NextResponse.json({ keys: await listWidgetKeys(tenantId) });
  } catch (err) {
    console.error("GET /api/widget-keys failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) ?? {};
    const origins = body.allowedOrigins;

    const invalid = validateOrigins(origins);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    const key = await createWidgetKey({
      tenantId,
      allowedOrigins: origins ?? [],
      label: typeof body.label === "string" ? body.label : undefined,
    });

    return NextResponse.json({ key }, { status: 201 });
  } catch (err) {
    console.error("POST /api/widget-keys failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}

export async function PATCH(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    const body = (await request.json().catch(() => null)) ?? {};
    if (!body.keyId) {
      return NextResponse.json({ error: "keyId is required" }, { status: 400 });
    }

    const invalid = validateOrigins(body.allowedOrigins, { required: true });
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    const key = await setAllowedOrigins({
      tenantId,
      keyId: body.keyId,
      allowedOrigins: body.allowedOrigins,
    });
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    return NextResponse.json({ key });
  } catch (err) {
    console.error("PATCH /api/widget-keys failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    const keyId = request.nextUrl.searchParams.get("keyId");
    if (!tenantId || !keyId) {
      return NextResponse.json({ error: "tenantId and keyId are required" }, { status: 400 });
    }

    const key = await revokeWidgetKey({ tenantId, keyId });
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    return NextResponse.json({ key });
  } catch (err) {
    console.error("DELETE /api/widget-keys failed:", err);
    return NextResponse.json({ error: err.message || "Something went wrong" }, { status: 500 });
  }
}

/**
 * Reject origins that don't parse, rather than silently dropping them.
 * A business that typos "acme.com" (no scheme) and gets a silent no-op would
 * see its widget blocked with nothing explaining why.
 */
function validateOrigins(origins, { required = false } = {}) {
  if (origins === undefined) {
    return required ? "allowedOrigins is required" : null;
  }
  if (!Array.isArray(origins)) return "allowedOrigins must be an array";

  const bad = origins.filter((o) => !normalizeOrigin(o));
  if (bad.length) {
    return `Invalid origins: ${bad.join(", ")} — use a full origin like https://acme.com`;
  }
  return null;
}
