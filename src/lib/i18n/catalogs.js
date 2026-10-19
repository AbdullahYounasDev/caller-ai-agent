import enCommon from "@/locales/en/common.json";
import enDashboard from "@/locales/en/dashboard.json";
import enCapabilities from "@/locales/en/capabilities.json";
import enValidation from "@/locales/en/validation.json";
import enErrors from "@/locales/en/errors.json";

import urCommon from "@/locales/ur/common.json";
import urDashboard from "@/locales/ur/dashboard.json";
import urCapabilities from "@/locales/ur/capabilities.json";
import urValidation from "@/locales/ur/validation.json";
import urErrors from "@/locales/ur/errors.json";

/**
 * Every ACTIVE catalog, statically imported.
 *
 * Active languages are English and Urdu — the only two the product supports.
 * Adding one later means five imports above, an entry below, its code in
 * SUPPORTED_LOCALES and in ACTIVE_LOCALES (scripts/check-locales.mjs).
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
  ur: {
    common: urCommon,
    dashboard: urDashboard,
    capabilities: urCapabilities,
    validation: urValidation,
    errors: urErrors,
  },
};

export const NAMESPACES = [
  "common",
  "dashboard",
  "capabilities",
  "validation",
  "errors",
];
