/**
 * TWILIO'S REST API — the one call we make: change what a LIVE call is doing (CLAUDE.md §6.30).
 * A transfer is "replace this call's instructions with a <Dial>": Twilio then ends our media
 * stream and rings the person.
 *
 * Never throws and never logs the Auth Token. The account and call ids are validated before they
 * are put into a URL (they come from Twilio's own messages, but a path built from a string is
 * checked all the same).
 */

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const CALL_SID = /^CA[0-9a-f]{32}$/i;

/**
 * @param {object} args
 * @param {string} args.accountSid
 * @param {string} args.authToken
 * @param {string} args.callSid
 * @param {string} args.twiml          the new instructions
 * @param {typeof fetch} [args.fetchImpl]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ok: true} | {ok: false, reason: "invalid" | "rejected" | "unreachable", status?: number}>}
 */
export async function redirectCall({ accountSid, authToken, callSid, twiml, fetchImpl = fetch, timeoutMs = 6_000 }) {
  if (!ACCOUNT_SID.test(accountSid ?? "") || !CALL_SID.test(callSid ?? "") || !authToken || !twiml) return { ok: false, reason: "invalid" };
  try {
    const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Twiml: twiml }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok ? { ok: true } : { ok: false, reason: "rejected", status: response.status };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}
