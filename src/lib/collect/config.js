import {
  COLLECT_LANGUAGES,
  CUSTOM_FIELD_TYPES,
  FIELDS,
  INDUSTRIES,
  LIMITS,
  RECORD_TYPES,
  getField,
  getIndustry,
  getRecordType,
  pick,
} from "./catalog";

/**
 * A TENANT'S COLLECTION SETTINGS — what its agent collects, for which kinds of request,
 * and how it asks. Stored as one JSON document in agent_configs.collect, written only
 * through PUT /api/collect, read by the engine on every message.
 *
 * Shape (everything optional on input; `normalizeCollectConfig` fills the rest):
 *
 *   {
 *     enabled: true,
 *     industry: "dental",                         the preset it started from (informational)
 *     services: [{ id, label: {en, ur} }],        the list the `service` field chooses from
 *     staff:    [{ id, label: {en, ur} }],        the list the `staff` field chooses from
 *     customFields: [{ id: "c_parking", type, label, question, options?, sensitive? }],
 *     recordTypes: {
 *       appointment: { enabled, label?: {en, ur}, fields: [{ id, required, question?: {en, ur} }] },
 *       callback:    { ... }
 *     }
 *   }
 *
 * TWO MODES, ONE PARSER. Reading a stored document must never throw or refuse (a bad
 * stored value degrades to the nearest valid one, because a conversation is waiting on
 * it); a SAVE must tell the owner exactly what is wrong. Both run `parse`; the first
 * ignores the problems, the second returns them as translatable codes
 * (`validation:collect.<code>`), the same way /api/agent-config does.
 *
 * Pure: no database, no clock, no environment (tests/collect-config.test.mjs).
 */

/** @typedef {{code: string, vars?: Record<string, string|number>}} Problem */

const SLUG = /^[a-z0-9_]{1,40}$/;
const CUSTOM_ID = /^c_[a-z0-9_]{1,30}$/;

const clean = (value, max) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** A `{en, ur}` pair with each side trimmed and clamped; empty sides are dropped. */
function pair(value, max, problems, code) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const language of COLLECT_LANGUAGES) {
    const raw = value[language];
    if (raw == null) continue;
    const text = String(raw).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > max) problems?.push({ code, vars: { max } });
    out[language] = text.slice(0, max);
  }
  return out;
}

const hasText = (p) => Boolean(p.en || p.ur);

/** "Root canal" -> "root_canal"; null when nothing usable is left (an Urdu-only label). */
function slugOf(text) {
  const slug = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  return slug || null;
}

/** An owner-defined list (services, staff): unique ids, at least one label each. */
function parseList(value, problems, code) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    problems?.push({ code: "listInvalid", vars: { list: code } });
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const label = pair(item?.label ?? item, LIMITS.labelMax, problems, "labelTooLong");
    if (!hasText(label)) continue;
    let id = typeof item?.id === "string" && SLUG.test(item.id) ? item.id : slugOf(label.en) ?? `${code[0]}${out.length + 1}`;
    for (let n = 2; seen.has(id); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
    seen.add(id);
    out.push({ id, label });
    if (out.length >= LIMITS.listMax) {
      if (value.length > LIMITS.listMax) problems?.push({ code: "listTooLong", vars: { list: code, max: LIMITS.listMax } });
      break;
    }
  }
  return out;
}

function parseCustomFields(value, problems) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    problems?.push({ code: "customInvalid" });
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const label = pair(item?.label, LIMITS.labelMax, problems, "labelTooLong");
    const id = typeof item?.id === "string" ? item.id : "";
    if (!CUSTOM_ID.test(id) || getField(id) || seen.has(id)) {
      problems?.push({ code: "customIdInvalid", vars: { id: id || "?" } });
      continue;
    }
    if (!CUSTOM_FIELD_TYPES.includes(item?.type)) {
      problems?.push({ code: "customTypeInvalid", vars: { id } });
      continue;
    }
    if (!hasText(label)) {
      problems?.push({ code: "customLabelRequired", vars: { id } });
      continue;
    }
    const field = {
      id,
      type: item.type,
      label,
      question: pair(item.question, LIMITS.questionMax, problems, "questionTooLong"),
      sensitive: item.sensitive === true,
    };
    if (item.type === "choice") {
      const options = parseList(item.options, problems, "options").slice(0, LIMITS.optionsMax);
      if (options.length < 2) {
        problems?.push({ code: "customOptionsRequired", vars: { id } });
        continue;
      }
      field.options = options;
    }
    seen.add(id);
    out.push(field);
    if (out.length >= LIMITS.customFieldsMax) {
      if (value.length > LIMITS.customFieldsMax) problems?.push({ code: "customTooMany", vars: { max: LIMITS.customFieldsMax } });
      break;
    }
  }
  return out;
}

/** The preset's selection for one record type, as a config entry. */
function presetEntry(industry, typeId) {
  const general = getIndustry("general");
  const from = industry?.recordTypes?.[typeId];
  const entry = from ?? { ...general.recordTypes[typeId], enabled: false };
  return {
    enabled: entry.enabled,
    ...(entry.label ? { label: { ...entry.label } } : {}),
    fields: entry.fields.map((x) => ({ id: x.id, required: x.required })),
  };
}

/**
 * The configuration an industry starts from. Services are NOT filled in: they are the
 * business's own list; the console offers the preset's suggestions as a one-click add.
 *
 * @param {string} industryId
 * @returns {object} a complete, valid config with `enabled` left to the caller
 */
export function presetConfig(industryId) {
  const industry = getIndustry(industryId) ?? getIndustry("general");
  return {
    enabled: false,
    industry: industry.id,
    services: [],
    staff: [],
    customFields: [],
    recordTypes: Object.fromEntries(RECORD_TYPES.map((t) => [t.id, presetEntry(industry, t.id)])),
  };
}

/** What a tenant has until it sets this up: off, with nothing chosen. */
export function emptyCollectConfig() {
  return { ...presetConfig("general"), industry: null };
}

function parseRecordTypes(value, customIds, problems) {
  const out = {};
  const given = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  for (const id of Object.keys(given)) {
    if (!getRecordType(id)) problems?.push({ code: "recordTypeUnknown", vars: { id } });
  }

  for (const type of RECORD_TYPES) {
    const raw = given[type.id];
    if (!raw || typeof raw !== "object") {
      out[type.id] = presetEntry(null, type.id);
      continue;
    }
    const fields = [];
    const seen = new Set();
    for (const item of Array.isArray(raw.fields) ? raw.fields : []) {
      const id = typeof item === "string" ? item : item?.id;
      if (!getField(id) && !customIds.has(id)) {
        problems?.push({ code: "fieldUnknown", vars: { id: String(id), type: type.id } });
        continue;
      }
      if (seen.has(id)) {
        problems?.push({ code: "fieldDuplicate", vars: { id, type: type.id } });
        continue;
      }
      seen.add(id);
      const question = typeof item === "string" ? {} : pair(item?.question, LIMITS.questionMax, problems, "questionTooLong");
      fields.push({
        id,
        // A bare id means "ask it"; an object must say so — a missing flag is optional.
        required: typeof item === "string" ? true : item?.required === true,
        ...(hasText(question) ? { question } : {}),
      });
    }
    if (fields.length > LIMITS.fieldsMax) {
      problems?.push({ code: "tooManyFields", vars: { type: type.id, max: LIMITS.fieldsMax } });
      fields.length = LIMITS.fieldsMax;
    }
    const label = pair(raw.label, LIMITS.labelMax, problems, "labelTooLong");
    const entry = { enabled: raw.enabled === true, ...(hasText(label) ? { label } : {}), fields };

    if (entry.enabled) {
      const ids = new Set(fields.map((x) => x.id));
      if (!fields.length) problems?.push({ code: "noFields", vars: { type: type.id } });
      for (const must of type.mustInclude) {
        if (fields.length && !ids.has(must)) problems?.push({ code: "mustInclude", vars: { type: type.id, field: must } });
      }
      // The team has to be able to reach the customer: at least one contact field must be
      // REQUIRED, or a customer who skips it leaves a request nobody can answer.
      if (fields.length && !fields.some((x) => type.mustReach.includes(x.id) && x.required)) {
        problems?.push({ code: "mustReach", vars: { type: type.id, fields: type.mustReach.join(", ") } });
      }
    }
    out[type.id] = entry;
  }
  return out;
}

function parse(raw, { collect = false } = {}) {
  const problems = collect ? [] : null;
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (collect && raw != null && (typeof raw !== "object" || Array.isArray(raw))) problems.push({ code: "invalid" });

  let industry = null;
  if (input.industry != null) {
    if (getIndustry(input.industry)) industry = input.industry;
    else problems?.push({ code: "industryUnknown", vars: { id: String(input.industry) } });
  }

  const customFields = parseCustomFields(input.customFields, problems);
  const customIds = new Set(customFields.map((x) => x.id));
  const config = {
    enabled: input.enabled === true,
    industry,
    services: parseList(input.services, problems, "services"),
    staff: parseList(input.staff, problems, "staff"),
    customFields,
    recordTypes: parseRecordTypes(input.recordTypes, customIds, problems),
  };

  // Switching the feature on with nothing to collect would make every request empty.
  if (collect && config.enabled && !RECORD_TYPES.some((t) => config.recordTypes[t.id].enabled)) {
    problems.push({ code: "nothingEnabled" });
  }
  return { config, problems: problems ?? [] };
}

/**
 * Read a stored (or partial) document: always returns a complete valid config, silently
 * dropping what is wrong.
 * @param {unknown} raw
 */
export function normalizeCollectConfig(raw) {
  return parse(raw).config;
}

/**
 * Check a document an owner is saving.
 * @param {unknown} raw
 * @returns {{ok: boolean, config: object, problems: Problem[]}}
 */
export function validateCollectConfig(raw) {
  const { config, problems } = parse(raw, { collect: true });
  return { ok: problems.length === 0, config, problems };
}

/**
 * A field as the engine and the console use it: the catalogue entry, or an owner's custom
 * field shaped the same way.
 * @param {object} config a normalized collect config
 * @param {string} id
 */
export function fieldDef(config, id) {
  const builtIn = getField(id);
  if (builtIn) return builtIn;
  const custom = config?.customFields?.find((x) => x.id === id);
  if (!custom) return null;
  return {
    id: custom.id,
    type: custom.type,
    group: "other",
    sensitivity: custom.sensitive ? "sensitive" : "normal",
    label: custom.label,
    question: custom.question,
    max: custom.type === "longtext" ? 500 : 120,
    ...(custom.type === "number" ? { min: 0, max: 1_000_000 } : {}),
    ...(custom.options ? { options: custom.options } : {}),
    custom: true,
  };
}

/** Options of a `choice` field: the owner's services/staff list, or the custom field's own. */
export function choiceOptions(config, def) {
  if (def?.source) return config?.[def.source] ?? [];
  return def?.options ?? [];
}

/**
 * The fields of one record type in the order they are asked, ready to use: each carries
 * `required` and the question to ask in BOTH languages (the owner's wording, else the
 * catalogue's, else a plain "please tell me <label>").
 *
 * @param {object} config
 * @param {string} typeId
 */
export function typeFields(config, typeId) {
  const entry = config?.recordTypes?.[typeId];
  if (!entry) return [];
  const out = [];
  for (const item of entry.fields) {
    const def = fieldDef(config, item.id);
    if (!def) continue;
    const question = {};
    for (const language of COLLECT_LANGUAGES) {
      question[language] =
        item.question?.[language] ||
        def.question?.[language] ||
        (language === "ur" ? `براہِ کرم بتائیں: ${pick(def.label, "ur")}` : `Please tell me: ${pick(def.label, "en")}`);
    }
    out.push({ ...def, required: item.required, question });
  }
  return out;
}

/** What the business calls a record type in one language ("Table reservation"). */
export function recordTypeLabel(config, typeId, language) {
  const override = config?.recordTypes?.[typeId]?.label;
  if (override && hasText(override)) return pick(override, language);
  return pick(getRecordType(typeId)?.label, language);
}

/** The ids of the record types this tenant has switched on, catalogue order. */
export function enabledRecordTypes(config) {
  if (!config?.enabled) return [];
  return RECORD_TYPES.filter((t) => config.recordTypes?.[t.id]?.enabled && config.recordTypes[t.id].fields.length).map((t) => t.id);
}

/** How many fields a type asks — the console warns when this gets long for a phone call. */
export function fieldCount(config, typeId) {
  return config?.recordTypes?.[typeId]?.fields?.length ?? 0;
}

/** Everything the console needs to draw the checklist, in one translatable-by-the-client object. */
export function describeCatalog() {
  return {
    languages: COLLECT_LANGUAGES,
    limits: LIMITS,
    fields: FIELDS,
    recordTypes: RECORD_TYPES,
    industries: INDUSTRIES.map((i) => ({
      id: i.id,
      label: i.label,
      suggestedServices: i.suggestedServices ?? [],
      config: presetConfig(i.id),
    })),
  };
}
