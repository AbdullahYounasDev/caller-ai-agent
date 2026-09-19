import enCommon from "@/locales/en/common.json";
import enWidget from "@/locales/en/widget.json";
import enErrors from "@/locales/en/errors.json";

import itCommon from "@/locales/it/common.json";
import itWidget from "@/locales/it/widget.json";
import itErrors from "@/locales/it/errors.json";

import arCommon from "@/locales/ar/common.json";
import arWidget from "@/locales/ar/widget.json";
import arErrors from "@/locales/ar/errors.json";

import urCommon from "@/locales/ur/common.json";
import urWidget from "@/locales/ur/widget.json";
import urErrors from "@/locales/ur/errors.json";

/**
 * Every catalog, statically imported.
 *
 * WHY STATIC: the server handles requests in all four languages, so it needs all
 * four anyway, and static imports mean a missing or malformed JSON file is a
 * BUILD failure rather than a 500 at 2am on a customer's site.
 *
 * WHEN YOU BUILD THE WIDGET BUNDLE (Phase 2): don't import this file. A browser
 * only ever needs the one locale it's rendering, and shipping Arabic and Urdu to
 * an English visitor is dead bytes in a bundle that loads on someone else's
 * site. Import `@/locales/<locale>/widget.json` dynamically there instead — the
 * JSON files are the shared source of truth, this aggregation is not.
 */
export const CATALOGS = {
  en: { common: enCommon, widget: enWidget, errors: enErrors },
  it: { common: itCommon, widget: itWidget, errors: itErrors },
  ar: { common: arCommon, widget: arWidget, errors: arErrors },
  ur: { common: urCommon, widget: urWidget, errors: urErrors },
};

export const NAMESPACES = ["common", "widget", "errors"];
