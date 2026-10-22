/**
 * Route-facing translation of phone-number errors (§6.29), so no route grows its own copy.
 *
 * @param {unknown} err a NumberRuleError from standins/numbers.js
 * @param {(key: string, opts?: object) => string} tr
 * @returns {{status: number, error: string} | null} null = not ours, let it be a 500
 */
export function describeNumberError(err, tr) {
  if (err?.name !== "NumberRuleError") return null;
  return { status: err.status ?? 400, error: tr(`validation:numbers.${err.code}`, err.vars ? { vars: err.vars } : undefined) };
}

/**
 * The owner-facing sentence for why a dialled number does not ring an agent (a resolveDialledNumber
 * refusal) — the console's "call as if dialling" shows it; a real caller only ever hears
 * voiceLine("not_in_service").
 */
export function describeRouteRefusal(reason, tr) {
  return tr(`validation:numbers.route.${reason}`);
}
