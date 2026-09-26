import enCommon from "@/locales/en/common.json";
import enDashboard from "@/locales/en/dashboard.json";
import enCapabilities from "@/locales/en/capabilities.json";
import enValidation from "@/locales/en/validation.json";
import enErrors from "@/locales/en/errors.json";

import itCommon from "@/locales/it/common.json";
import itDashboard from "@/locales/it/dashboard.json";
import itCapabilities from "@/locales/it/capabilities.json";
import itValidation from "@/locales/it/validation.json";
import itErrors from "@/locales/it/errors.json";

/**
 * Every ACTIVE catalog, statically imported.
 *
 * Active languages are English and Italian. The `ar` and `ur` catalogs are
 * still on disk, fully translated, but DORMANT — reactivating one means adding
 * its six imports above and an entry below, plus its code to SUPPORTED_LOCALES
 * and ACTIVE_LOCALES (scripts/check-locales.mjs). Nothing else.
 *
 * THE NAMESPACES COVER THE WHOLE PRODUCT, not one screen:
 *   common       shared words — buttons, states, language and tone names
 *   dashboard    the business-facing admin screens: labels, help text, sections
 *   capabilities what the agent can do, as a business reads it in the dashboard
 *   validation   what a business is told when it enters something invalid
 *   errors       runtime failures shown to whoever is talking to the agent
 *
 * There was a sixth, `widget`, for the embeddable browser chat. That channel was
 * removed; do not add the namespace back without the channel.
 *
 * Picking a language changes ALL of it. Nothing user-facing anywhere in the
 * system is a literal string in code.
 *
 * WHY STATIC: the server handles requests in every active language, so it needs
 * them all anyway, and static imports mean a missing or malformed JSON file is
 * a BUILD failure rather than a 500 at 2am on a customer's site.
 *
 * The server handles every active language, so it imports them all. A client
 * that only needs one should fetch it from /api/locales rather than importing
 * this file.
 */
export const CATALOGS = {
  en: {
    common: enCommon,
    dashboard: enDashboard,
    capabilities: enCapabilities,
    validation: enValidation,
    errors: enErrors,
  },
  it: {
    common: itCommon,
    dashboard: itDashboard,
    capabilities: itCapabilities,
    validation: itValidation,
    errors: itErrors,
  },
};

export const NAMESPACES = [
  "common",
  "dashboard",
  "capabilities",
  "validation",
  "errors",
];
