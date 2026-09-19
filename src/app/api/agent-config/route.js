import { NextResponse } from "next/server";
import { getAgentConfig, saveAgentConfig, SUPPORTED_LOCALES } from "@/lib/tenant/config";
import { getCapability } from "@/lib/agent/capabilities/catalog";
import { checkInternalAuth } from "@/lib/auth/internal";

/**
 * THE CONTRACT WITH THE PARTNER'S DASHBOARD.
 *
 *   GET  /api/agent-config?tenantId=…   read a tenant's agent configuration
 *   PUT  /api/agent-config?tenantId=…   patch it (only the keys you send are written)
 *
 * Server-to-server only — the dashboard's BACKEND calls this with the shared
 * x-internal-key header. It must never be called from a browser (see
 * lib/auth/internal.js). The widget gets its own public, per-tenant endpoint in
 * Phase 1b; do not widen this one to serve it.
 */

const TONES = ["professional", "friendly", "concise", "formal"];
const CHANNELS = ["widget", "whatsapp", "voice"];

export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    // skipCache: the dashboard must never show a business a stale copy of the
    // settings it is about to edit — that's how edits get silently overwritten.
    const config = await getAgentConfig(tenantId, { skipCache: true });
    return NextResponse.json({ config });
  } catch (err) {
    console.error("GET /api/agent-config failed:", err);
    return NextResponse.json(
      { error: err.message || "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PUT(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: "tenantId is required" }, { status: 400 });
    }

    const patch = await request.json().catch(() => null);
    if (!patch || typeof patch !== "object") {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }

    const errors = validatePatch(patch);
    if (errors.length) {
      return NextResponse.json({ error: "Invalid configuration", details: errors }, { status: 400 });
    }

    const config = await saveAgentConfig(tenantId, patch);
    return NextResponse.json({ config });
  } catch (err) {
    console.error("PUT /api/agent-config failed:", err);
    return NextResponse.json(
      { error: err.message || "Something went wrong" },
      { status: 500 }
    );
  }
}

/**
 * Validate at the boundary, not deeper in. Everything here ends up either in a
 * system prompt or in the widget's CSS, so garbage that gets through doesn't
 * throw — it quietly produces a broken agent for a real business, which is much
 * harder to notice and much worse.
 *
 * @returns {string[]} human-readable problems, empty when valid
 */
function validatePatch(patch) {
  const errors = [];

  if (patch.businessName !== undefined) {
    if (typeof patch.businessName !== "string" || !patch.businessName.trim()) {
      errors.push("businessName must be a non-empty string");
    } else if (patch.businessName.length > 120) {
      errors.push("businessName must be 120 characters or fewer");
    }
  }

  if (patch.purpose !== undefined) {
    if (typeof patch.purpose !== "string") {
      errors.push("purpose must be a string");
    } else if (patch.purpose.length > 2000) {
      // This goes straight into the system prompt. Unbounded text here is both a
      // token-cost problem and a prompt-injection surface.
      errors.push("purpose must be 2000 characters or fewer");
    }
  }

  if (patch.tone !== undefined && !TONES.includes(patch.tone)) {
    errors.push(`tone must be one of: ${TONES.join(", ")}`);
  }

  if (patch.timezone !== undefined && typeof patch.timezone !== "string") {
    errors.push("timezone must be an IANA timezone string");
  }

  if (patch.languages !== undefined) {
    if (!Array.isArray(patch.languages) || patch.languages.length === 0) {
      errors.push("languages must be a non-empty array");
    } else {
      const bad = patch.languages.filter((l) => !SUPPORTED_LOCALES.includes(l));
      if (bad.length) {
        errors.push(
          `unsupported languages: ${bad.join(", ")} (supported: ${SUPPORTED_LOCALES.join(", ")})`
        );
      }
    }
  }

  if (patch.defaultLocale !== undefined) {
    if (!SUPPORTED_LOCALES.includes(patch.defaultLocale)) {
      errors.push(`defaultLocale must be one of: ${SUPPORTED_LOCALES.join(", ")}`);
    } else if (
      Array.isArray(patch.languages) &&
      !patch.languages.includes(patch.defaultLocale)
    ) {
      // Caught here rather than silently corrected, because the dashboard can
      // show the business exactly which two settings contradict each other.
      errors.push("defaultLocale must be one of the enabled languages");
    }
  }

  if (patch.capabilities !== undefined) {
    if (typeof patch.capabilities !== "object" || patch.capabilities === null || Array.isArray(patch.capabilities)) {
      errors.push("capabilities must be an object keyed by capability id");
    } else {
      for (const [id, state] of Object.entries(patch.capabilities)) {
        const capability = getCapability(id);
        if (!capability) {
          errors.push(`unknown capability: ${id}`);
          continue;
        }
        if (typeof state !== "object" || state === null) {
          errors.push(`capabilities.${id} must be an object`);
          continue;
        }
        if (state.enabled !== undefined && typeof state.enabled !== "boolean") {
          errors.push(`capabilities.${id}.enabled must be a boolean`);
        }
        if (state.channels !== undefined) {
          if (!Array.isArray(state.channels)) {
            errors.push(`capabilities.${id}.channels must be an array`);
          } else {
            const bad = state.channels.filter((c) => !CHANNELS.includes(c));
            if (bad.length) errors.push(`capabilities.${id}: unknown channels ${bad.join(", ")}`);

            // A tenant can narrow a capability's channels but never widen them —
            // "book an appointment" over a channel the capability can't run on
            // would put a promise in the prompt that nothing can keep.
            const unsupported = state.channels.filter((c) => !capability.channels.includes(c));
            if (unsupported.length) {
              errors.push(
                `capabilities.${id} does not support: ${unsupported.join(", ")} ` +
                  `(supported: ${capability.channels.join(", ")})`
              );
            }
          }
        }
      }
    }
  }

  if (patch.widget !== undefined) {
    if (typeof patch.widget !== "object" || patch.widget === null || Array.isArray(patch.widget)) {
      errors.push("widget must be an object");
    } else {
      const { primaryColor, logoUrl, position } = patch.widget;
      if (primaryColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(primaryColor))) {
        // Interpolated into the widget's styles — anything other than a literal
        // hex colour is a CSS injection waiting to happen.
        errors.push("widget.primaryColor must be a hex colour like #2563eb");
      }
      if (logoUrl !== undefined && logoUrl !== null && !/^https:\/\//.test(String(logoUrl))) {
        // https only: an http logo on an https host is a mixed-content block,
        // and the widget would render broken on the customer's own site.
        errors.push("widget.logoUrl must be an https URL");
      }
      if (position !== undefined && !["bottom-end", "bottom-start"].includes(position)) {
        // Logical, not left/right — these flip correctly for ar and ur.
        errors.push("widget.position must be bottom-end or bottom-start");
      }
    }
  }

  return errors;
}
