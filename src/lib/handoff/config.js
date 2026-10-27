import { normalizePhone } from "@/lib/collect/validate";
import { announceProblems, normalizeAnnounce } from "./announce";

/**
 * A BUSINESS'S HUMAN-HANDOFF SETTINGS — who a caller may be passed to, and when.
 *
 * Stored in the existing `agent_configs.escalation` JSON column (so no migration and, later, no
 * change for the backend: it stores one more JSON document next to the others, CLAUDE.md §4).
 *
 *   {
 *     enabled: true,                               the owner's switch
 *     contacts: [                                  in priority order, first is tried first
 *       { id: "c1", role: "Senior doctor", name: "Dr Ayesha", phone: "+923001234567" }
 *     ],
 *     whenCallerAsks: true,                        "let me talk to a person" always forwards
 *     afterMisses: 2,                              how many times the agent may fail to understand
 *                                                  or help before it forwards (1–4)
 *     topics: ["complaint", "refund", "emergency"], words that ALWAYS forward
 *     outsideHours: "callback",                    closed → offer a call-back; "forward" → forward anyway
 *     announce: { en?: "...", ur?: "..." }         the owner's own line before a transfer, with {name}
 *                                                  and {role}; empty = the built-in one (announce.js)
 *   }
 *
 * The phone numbers are NEVER put in a prompt (the model would read them out): they are only
 * ever handed to the transport that places the transfer (voice/session.js).
 *
 * Two modes, one parser (the same pattern as collect/config.js): reading a stored document
 * never throws and degrades to the nearest valid one (a call is waiting); a SAVE returns every
 * problem as a translatable code (`validation:handoff.<code>`).
 *
 * Pure (tests/handoff.test.mjs).
 */

export const LIMITS = {
  contactsMax: 5,
  textMax: 60,
  topicsMax: 10,
  topicMax: 40,
  missesMin: 1,
  missesMax: 4,
};

export const DEFAULT_AFTER_MISSES = 2;
export const OUTSIDE_HOURS = ["callback", "forward"];

/** @returns {object} the settings of a business that has not set handoff up (off). */
export function emptyHandoffConfig() {
  return { enabled: false, contacts: [], whenCallerAsks: true, afterMisses: DEFAULT_AFTER_MISSES, topics: [], outsideHours: "callback", announce: {} };
}

const clean = (value, max) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * @param {unknown} raw whatever is stored (or sent)
 * @returns {{config: object, problems: Array<{code: string, vars?: object}>}}
 */
function parse(raw) {
  const problems = [];
  const out = emptyHandoffConfig();
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (raw != null && input !== raw) problems.push({ code: "invalid" });

  out.enabled = input.enabled === true;
  // The old shape called this `whenUserAsks`; keep its meaning.
  const asks = input.whenCallerAsks ?? input.whenUserAsks;
  out.whenCallerAsks = asks === undefined ? true : asks !== false;

  const misses = Number(input.afterMisses ?? DEFAULT_AFTER_MISSES);
  if (!Number.isInteger(misses) || misses < LIMITS.missesMin || misses > LIMITS.missesMax) {
    if (input.afterMisses !== undefined) problems.push({ code: "missesRange", vars: { min: LIMITS.missesMin, max: LIMITS.missesMax } });
  } else out.afterMisses = misses;

  // The line said before a transfer: refused only when it cannot be spoken as meant (too long, a
  // placeholder other than {name}/{role} that would be read out literally).
  problems.push(...announceProblems(input.announce));
  out.announce = normalizeAnnounce(input.announce);

  if (input.outsideHours !== undefined) {
    if (OUTSIDE_HOURS.includes(input.outsideHours)) out.outsideHours = input.outsideHours;
    else problems.push({ code: "outsideHoursInvalid" });
  }

  const topics = Array.isArray(input.topics) ? input.topics : [];
  if (input.topics !== undefined && !Array.isArray(input.topics)) problems.push({ code: "topicsInvalid" });
  const seenTopics = new Set();
  for (const topic of topics) {
    const text = clean(topic, LIMITS.topicMax + 1);
    if (!text) continue;
    if (text.length > LIMITS.topicMax) {
      problems.push({ code: "topicTooLong", vars: { max: LIMITS.topicMax } });
      continue;
    }
    if (seenTopics.has(text.toLowerCase())) continue;
    seenTopics.add(text.toLowerCase());
    if (out.topics.length >= LIMITS.topicsMax) {
      problems.push({ code: "tooManyTopics", vars: { max: LIMITS.topicsMax } });
      break;
    }
    out.topics.push(text);
  }

  const contacts = Array.isArray(input.contacts) ? input.contacts : [];
  if (input.contacts !== undefined && !Array.isArray(input.contacts)) problems.push({ code: "contactsInvalid" });
  const seenPhones = new Set();
  contacts.forEach((entry, index) => {
    const position = index + 1;
    if (!entry || typeof entry !== "object") return problems.push({ code: "contactIncomplete", vars: { index: position } });
    const role = clean(entry.role, LIMITS.textMax);
    const name = clean(entry.name, LIMITS.textMax);
    const rawPhone = String(entry.phone ?? "").trim();
    // A completely empty row (the owner added one and left it) is just dropped.
    if (!role && !name && !rawPhone) return;
    if (!role && !name) return problems.push({ code: "contactIncomplete", vars: { index: position } });
    const phone = normalizePhone(rawPhone);
    if (!phone.ok) return problems.push({ code: "invalidPhone", vars: { index: position } });
    if (seenPhones.has(phone.value)) return problems.push({ code: "duplicatePhone", vars: { index: position } });
    if (out.contacts.length >= LIMITS.contactsMax) return problems.push({ code: "tooManyContacts", vars: { max: LIMITS.contactsMax } });
    seenPhones.add(phone.value);
    out.contacts.push({ id: clean(entry.id, 30) || `c${position}`, role, name, phone: phone.value });
  });

  // Switched on with nobody to forward to is a trap: callers would be promised a person.
  if (out.enabled && out.contacts.length === 0) problems.push({ code: "enabledNeedsContact" });
  return { config: out, problems };
}

/**
 * Read a stored document. Never throws; a bad or half-written one degrades to something safe.
 * A business that is "enabled" with no usable contact is read as OFF — nobody can be forwarded to.
 *
 * @param {unknown} raw
 */
export function normalizeHandoffConfig(raw) {
  const { config } = parse(raw);
  if (config.contacts.length === 0) config.enabled = false;
  return config;
}

/**
 * Check a document an owner is saving.
 * @param {unknown} raw
 * @returns {{ok: boolean, config: object, problems: Array<{code: string, vars?: object}>}}
 */
export function validateHandoffConfig(raw) {
  const { config, problems } = parse(raw);
  return { ok: problems.length === 0, config, problems };
}

/** @returns {boolean} handoff is on AND there is someone to hand to. */
export function handoffAvailable(config) {
  return Boolean(config?.enabled && config.contacts?.length);
}
