import { NextResponse } from "next/server";
import { getAgentConfig, saveAgentConfig } from "@/lib/tenant/config";
import { getCapability } from "@/lib/agent/capabilities/catalog";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import {
  translator,
  resolveLocale,
  SUPPORTED_LOCALES,
  REPLY_LANGUAGES,
} from "@/lib/i18n";

/**
 * THE CONTRACT WITH THE PARTNER'S DASHBOARD.
 *
 *   GET  /api/agent-config?tenantId=…            read a tenant's agent configuration
 *   PUT  /api/agent-config?tenantId=…            patch it (only the keys you send are written)
 *
 * Both accept `&locale=` — the UI LOCALE, i.e. the language the business owner
 * is reading the dashboard in. Validation messages come back in that language,
 * because these are messages a real person reads and acts on. An English-only
 * error inside an Italian dashboard is a dead end.
 *
 * When no locale is given we use the tenant's saved `uiLocale`, then the
 * browser's Accept-Language, then English.
 *
 * Server-to-server only — the dashboard's BACKEND calls this with the shared
 * x-internal-key header. It must never be called from a browser (see
 * lib/auth/internal.js). Every caller today is internal; when telephony lands
 * its webhook authenticates by provider signature, not through this route.
 */

const TONES = ["professional", "friendly", "concise", "formal"];
const CHANNELS = ["chat", "voice"];
const MAX_BUSINESS_NAME = 120;
const MAX_PURPOSE = 2000;

/**
 * UI language for this request.
 *
 * ORDER, and it differs from the conversation-locale order on purpose:
 *   1. an explicit ?locale= — the dashboard previewing a language mid-change
 *   2. the tenant's SAVED uiLocale — an explicit decision by the business owner
 *   3. the browser's Accept-Language — a guess about a first-time visitor
 *   4. English
 *
 * A saved preference outranks the browser header here, which is the reverse of
 * how an end customer's language is chosen. The difference is who is speaking:
 * a business owner who set their dashboard to Italian means it, and shouldn't
 * be overridden by an en-US browser. An end customer never set anything, so
 * their browser is the best signal we have about them.
 */
async function uiLocaleFor(request, tenantId) {
  let saved;
  if (tenantId) {
    try {
      saved = (await getAgentConfig(tenantId)).uiLocale;
    } catch {
      // A config read failing must not turn into a wrong-language error message
      // on top of whatever actually went wrong.
    }
  }

  return resolveLocale({
    // Both count as "explicit"; the query param wins by being checked first.
    requested: request.nextUrl.searchParams.get("locale") || saved,
    acceptLanguage: request.headers.get("accept-language"),
    enabled: undefined, // dashboard language is not limited by customer languages
    fallback: undefined,
  });
}

export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tenantId = request.nextUrl.searchParams.get("tenantId");
    const locale = await uiLocaleFor(request, tenantId);
    const tr = translator(locale);

    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    // skipCache: the dashboard must never show a business a stale copy of the
    // settings it is about to edit — that's how edits get silently overwritten.
    const config = await getAgentConfig(tenantId, { skipCache: true });
    return NextResponse.json({ config, locale });
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
    const locale = await uiLocaleFor(request, tenantId);
    const tr = translator(locale);

    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    // Mutates the tenant's agent configuration — the partner's dashboard
    // contract (§4), so it goes through the same shared check every other
    // mutating route does.
    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) {
      return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });
    }

    const patch = await request.json().catch(() => null);
    if (!patch || typeof patch !== "object") {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }

    const errors = validatePatch(patch, tr);
    if (errors.length) {
      return NextResponse.json(
        { error: tr("common:state.error"), details: errors, locale },
        { status: 400 }
      );
    }

    const config = await saveAgentConfig(tenantId, patch);
    // Echo the locale the SAVED config now implies, so a dashboard that just
    // changed its own language knows to re-fetch its strings.
    return NextResponse.json({ config, locale: config.uiLocale });
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
 * system prompt, so garbage that gets through does not throw — it quietly
 * produces a broken agent for a real business, which is much harder to notice
 * and much worse.
 *
 * @param {object} patch
 * @param {(key: string, opts?: object) => string} tr bound translator
 * @returns {string[]} human-readable problems in the reader's language
 */
function validatePatch(patch, tr) {
  const errors = [];
  const list = (values) => values.join(", ");

  if (patch.businessName !== undefined) {
    if (typeof patch.businessName !== "string" || !patch.businessName.trim()) {
      errors.push(tr("validation:businessName.required"));
    } else if (patch.businessName.length > MAX_BUSINESS_NAME) {
      errors.push(tr("validation:businessName.tooLong", { vars: { max: MAX_BUSINESS_NAME } }));
    }
  }

  if (patch.purpose !== undefined) {
    if (typeof patch.purpose !== "string") {
      errors.push(tr("validation:purpose.invalid"));
    } else if (patch.purpose.length > MAX_PURPOSE) {
      // This goes straight into the system prompt. Unbounded text here is both a
      // token-cost problem and a prompt-injection surface.
      errors.push(tr("validation:purpose.tooLong", { vars: { max: MAX_PURPOSE } }));
    }
  }

  if (patch.tone !== undefined && !TONES.includes(patch.tone)) {
    errors.push(tr("validation:tone.invalid", { vars: { allowed: list(TONES) } }));
  }

  if (patch.timezone !== undefined && typeof patch.timezone !== "string") {
    errors.push(tr("validation:timezone.invalid"));
  }

  // Dashboard language. Independent of what the agent replies in: reading the
  // dashboard in Italian while the agent mirrors each customer is ordinary.
  if (patch.uiLocale !== undefined && !SUPPORTED_LOCALES.includes(patch.uiLocale)) {
    errors.push(tr("validation:locale.invalid", { vars: { allowed: list(SUPPORTED_LOCALES) } }));
  }

  // What the agent replies in: a fixed language, or "auto" to mirror the
  // customer. Unlike uiLocale this is not a locale, so it is checked against
  // REPLY_LANGUAGES rather than SUPPORTED_LOCALES.
  if (patch.replyLanguage !== undefined && !REPLY_LANGUAGES.includes(patch.replyLanguage)) {
    errors.push(tr("validation:replyLanguage.invalid", { vars: { allowed: list(REPLY_LANGUAGES) } }));
  }

  if (patch.capabilities !== undefined) {
    if (
      typeof patch.capabilities !== "object" ||
      patch.capabilities === null ||
      Array.isArray(patch.capabilities)
    ) {
      errors.push(tr("validation:capabilities.invalid"));
    } else {
      for (const [id, state] of Object.entries(patch.capabilities)) {
        const capability = getCapability(id);
        if (!capability) {
          errors.push(tr("validation:capabilities.unknown", { vars: { id } }));
          continue;
        }
        if (typeof state !== "object" || state === null) {
          errors.push(tr("validation:capabilities.invalidState", { vars: { id } }));
          continue;
        }
        if (state.enabled !== undefined && typeof state.enabled !== "boolean") {
          errors.push(tr("validation:capabilities.enabledInvalid", { vars: { id } }));
        }
        if (state.channels !== undefined) {
          if (!Array.isArray(state.channels)) {
            errors.push(tr("validation:capabilities.channelsInvalid", { vars: { id } }));
          } else {
            const bad = state.channels.filter((c) => !CHANNELS.includes(c));
            if (bad.length) {
              errors.push(
                tr("validation:capabilities.channelsUnknown", {
                  vars: { id, invalid: list(bad) },
                })
              );
            }

            // A tenant can narrow a capability's channels but never widen them —
            // "book an appointment" over a channel the capability can't run on
            // would put a promise in the prompt that nothing can keep.
            const unsupported = state.channels.filter(
              (c) => !capability.channels.includes(c)
            );
            if (unsupported.length) {
              errors.push(
                tr("validation:capabilities.channelsUnsupported", {
                  vars: {
                    id,
                    invalid: list(unsupported),
                    supported: list(capability.channels),
                  },
                })
              );
            }
          }
        }
      }
    }
  }


  return errors;
}
