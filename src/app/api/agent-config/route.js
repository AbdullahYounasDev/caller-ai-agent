import { NextResponse } from "next/server";
import { saveAgentConfig } from "@/lib/tenant/config";
import { getCapability } from "@/lib/agent/capabilities/catalog";
import { checkInternalAuth } from "@/lib/auth/internal";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { requireAgent } from "@/lib/tenant/agent-request";
import { uiLocaleFor } from "@/lib/tenant/ui-locale";
import { voiceSelectionProblems } from "@/lib/voice/speech/voices";
import { validateHandoffConfig } from "@/lib/handoff/config";
import { greetingProblems } from "@/lib/voice/greeting";
import { translator, SUPPORTED_LOCALES, REPLY_LANGUAGES } from "@/lib/i18n";

/**
 * THE CONTRACT WITH THE PARTNER'S DASHBOARD.
 *
 *   GET  /api/agent-config?tenantId=…[&agentId=…]   read one agent's configuration
 *   PUT  /api/agent-config?tenantId=…[&agentId=…]   patch it (only the keys you send are written)
 *
 * `agentId` picks one of the tenant's agents (GET /api/agents lists them); without it, the
 * tenant's DEFAULT agent — so a dashboard written before agents existed keeps working. The
 * response carries `agentId`, `name`, `isDefault` and `status`; manage those through
 * /api/agents. `uiLocale` is the tenant's (the dashboard language), whichever agent is edited.
 *
 * Both accept `&locale=` — the UI LOCALE, i.e. the language the business owner
 * is reading the dashboard in. Validation messages come back in that language,
 * because these are messages a real person reads and acts on. An English-only
 * error inside an Urdu dashboard is a dead end.
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
    const agent = await requireAgent({ tenantId, params: request.nextUrl.searchParams, tr, skipCache: true });
    if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });
    return NextResponse.json({ config: agent.config, locale });
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

    const agent = await requireAgent({ tenantId, params: request.nextUrl.searchParams, tr });
    if (!agent.ok) return NextResponse.json({ error: agent.error }, { status: agent.status });

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

    // agent.config.isDefault: a named default agent is saved as "the default" (agentId null), so a
    // tenant with no row yet gets one created rather than a 404.
    const config = await saveAgentConfig(tenantId, patch, { agentId: agent.config.isDefault ? null : agent.agentId });
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
  // dashboard in English while the agent answers callers in Urdu is ordinary.
  if (patch.uiLocale !== undefined && !SUPPORTED_LOCALES.includes(patch.uiLocale)) {
    errors.push(tr("validation:locale.invalid", { vars: { allowed: list(SUPPORTED_LOCALES) } }));
  }

  // What the agent replies in: English or Urdu (it understands both either way).
  // Checked against REPLY_LANGUAGES rather than SUPPORTED_LOCALES: they are two
  // settings that happen to hold the same two codes today.
  if (patch.replyLanguage !== undefined && !REPLY_LANGUAGES.includes(patch.replyLanguage)) {
    errors.push(tr("validation:replyLanguage.invalid", { vars: { allowed: list(REPLY_LANGUAGES) } }));
  }

  // The agent's voice per spoken language. Only voices the speech models actually have,
  // and only for the language they speak — an English voice for Urdu would be gibberish
  // to the caller, so it is refused here rather than discovered on a call.
  if (patch.voices !== undefined) {
    for (const problem of voiceSelectionProblems(patch.voices)) {
      // Split on the FIRST colon only — voice ids contain one ("kokoro:af_heart").
      const at = problem.indexOf(":");
      const kind = at === -1 ? problem : problem.slice(0, at);
      const detail = at === -1 ? "" : problem.slice(at + 1);
      errors.push(
        kind === "invalid"
          ? tr("validation:voices.invalid")
          : tr(`validation:voices.${kind === "language" ? "unknownLanguage" : "unknownVoice"}`, { vars: { value: detail } })
      );
    }
  }

  // Who a caller may be passed to (lib/handoff/config.js). Every problem is reported, in the
  // reader's language, before anything is saved: a half-valid list of people would promise
  // callers a transfer that can never connect.
  if (patch.escalation !== undefined) {
    for (const problem of validateHandoffConfig(patch.escalation).problems) {
      errors.push(tr(`validation:handoff.${problem.code}`, problem.vars ? { vars: problem.vars } : undefined));
    }
  }

  // The call's opening line (lib/voice/greeting.js). Refused only when it cannot be spoken as
  // meant (too long, an unknown {placeholder} that would be read out literally); leaving out the
  // AI or recording notice is the owner's choice and only WARNED about, in the console.
  if (patch.greeting !== undefined) {
    for (const problem of greetingProblems(patch.greeting)) {
      errors.push(tr(`validation:greeting.${problem.code}`, problem.vars ? { vars: problem.vars } : undefined));
    }
  }
  if (patch.recordCalls !== undefined && typeof patch.recordCalls !== "boolean") {
    errors.push(tr("validation:recordCalls.invalid"));
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
