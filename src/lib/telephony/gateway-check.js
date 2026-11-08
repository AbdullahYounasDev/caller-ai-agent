/**
 * IS THE VOICE GATEWAY ABLE TO TAKE THIS CALL? — asked by the webhook BEFORE it hands a call to the
 * gateway (CLAUDE.md §6.30). Without it a full or stopped gateway could only close the stream, and
 * the caller heard nothing at all. Asked first, the webhook can answer with a spoken line instead.
 *
 * It reads the gateway's own GET /health (the same address the stream uses, VOICE_GATEWAY_PUBLIC_URL):
 *   - not "ready" (models still loading, or failed)         → "unavailable"
 *   - activeCalls >= maxCalls                               → "busy"
 *   - `tenantAvailable === false` (this business is at its own concurrent-call limit) → "tenant_busy"
 *   - no answer within the timeout / not JSON / a network error → "unreachable"
 *
 * It is a courtesy, not the guard: the gateway still enforces every limit when the stream opens (a
 * call can slip in between the check and the stream — the check is a snapshot), and a refusal there
 * is a silent close, exactly as before.
 *
 * Pure apart from `fetchImpl`, which the tests replace.
 */

/** Twilio waits for the webhook for a few seconds; this must be a small slice of that. */
export const GATEWAY_CHECK_TIMEOUT_MS = 1_500;

/**
 * @param {object} args
 * @param {Record<string, string|undefined>} [args.env]
 * @param {string} [args.tenantId]  asks the gateway whether THIS business can take another call
 * @param {typeof fetch} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ok: true} | {ok: false, reason: "unavailable"|"busy"|"tenant_busy"|"unreachable"}>}
 */
export async function checkGatewayCapacity({ env = process.env, tenantId, fetchImpl = fetch, timeoutMs = GATEWAY_CHECK_TIMEOUT_MS } = {}) {
  const base = String(env.VOICE_GATEWAY_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (!base) return { ok: false, reason: "unreachable" };
  const url = `${base}/health${tenantId ? `?tenant=${encodeURIComponent(tenantId)}` : ""}`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") return { ok: false, reason: "unreachable" };
    if (body.status !== "ready") return { ok: false, reason: "unavailable" };
    if (Number.isFinite(body.activeCalls) && Number.isFinite(body.maxCalls) && body.activeCalls >= body.maxCalls) return { ok: false, reason: "busy" };
    if (body.tenantAvailable === false) return { ok: false, reason: "tenant_busy" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
