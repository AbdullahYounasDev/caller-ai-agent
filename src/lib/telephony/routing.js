/**
 * "THIS NUMBER WAS DIALLED — WHO ANSWERS?" — the pure half of the phone-number lookup
 * (CLAUDE.md §6.29). No database here: the reading is in standins/numbers.js (the backend's data,
 * stood in) and the seam that puts the two together is tenant/registry.js resolveDialledNumber().
 *
 * A number rings exactly ONE agent; an agent may have many numbers. Every call that cannot be
 * routed to an ACTIVE agent of a SERVICEABLE tenant is refused with a reason — never guessed,
 * never sent to "some" agent of the business, and never to another business.
 */

/** Why a dialled number cannot be answered. The phone transport says the same polite line for all of
 *  them (prompt.js voiceLine("not_in_service")); the reason goes to the call log. */
export const ROUTE_REFUSALS = Object.freeze([
  "invalid_number", // not a phone number in international form
  "unknown", // no business has this number
  "released", // a business had it and gave it up
  "unassigned", // the business has it but has not linked it to an agent yet
  "agent_archived", // linked to an agent that no longer answers
  "tenant_unserviceable", // the business is suspended / over quota (registry.js)
]);

/**
 * A dialled number in E.164 ("+442071234567"). Provider webhooks already send E.164; a person typing
 * a number into a dashboard does not, so spaces, dashes, dots, brackets and a leading "00" are
 * accepted. A number WITHOUT its country code is refused, not guessed: "020 7123 4567" is London to
 * a Briton and something else everywhere else, and a wrong guess routes a business's calls to a
 * stranger's line.
 *
 * @param {unknown} raw
 * @returns {{ok: true, value: string} | {ok: false, reason: "empty"|"needsCountryCode"|"invalid"}}
 */
export function toE164(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };
  // Only what people put between digits; anything else (letters, "x123" extensions) is not a number.
  if (!/^[+\d\s().\-/]+$/.test(text)) return { ok: false, reason: "invalid" };
  const plus = text.startsWith("+");
  if (text.indexOf("+", 1) !== -1) return { ok: false, reason: "invalid" };
  let digits = text.replace(/\D/g, "");
  if (!plus) {
    if (!digits.startsWith("00")) return { ok: false, reason: "needsCountryCode" };
    digits = digits.slice(2);
  }
  // E.164: a country code never starts with 0, and the whole number is at most 15 digits.
  if (digits.startsWith("0") || digits.length < 8 || digits.length > 15) return { ok: false, reason: "invalid" };
  return { ok: true, value: `+${digits}` };
}

/**
 * Decide from what the number store returned. `active` is the ACTIVE row for that number, or null;
 * `everHeld` says whether the number was ever held (a released row exists) — only to tell the call
 * log "released" from "unknown".
 *
 * @param {{active: null | {id: string, tenantId: string, agentId: string|null, agent?: {status: string}|null}, everHeld?: boolean}} found
 * @returns {{ok: true, tenantId: string, agentId: string, numberId: string} | {ok: false, reason: string, tenantId?: string, numberId?: string}}
 */
export function routeForNumber({ active, everHeld = false }) {
  if (!active) return { ok: false, reason: everHeld ? "released" : "unknown" };
  const where = { tenantId: active.tenantId, numberId: active.id };
  if (!active.agentId || !active.agent) return { ok: false, reason: "unassigned", ...where };
  if (active.agent.status !== "active") return { ok: false, reason: "agent_archived", ...where };
  return { ok: true, tenantId: active.tenantId, agentId: active.agentId, numberId: active.id };
}
