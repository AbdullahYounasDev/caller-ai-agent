"use client";

import { END_DELAY_SECONDS, normalizeCallEnding } from "@/lib/voice/closing";

/**
 * ENDING THE CALL — the Agent tab's "does the call end by itself, and how soon" (CLAUDE.md §6.24,
 * lib/voice/closing.js). Per agent: a switch, and the seconds of quiet after the agent's last words
 * before the call ends (any speech from the caller in that time keeps it open). Saved with the
 * Agent tab's own Save button; the server checks both again (PUT /api/agent-config).
 *
 * @param {object} props
 * @param {object} props.config   the agent being edited (autoEndCalls, endCallDelaySeconds)
 * @param {(patch: {autoEndCalls?: boolean, endCallDelaySeconds?: number}) => void} props.onChange
 * @param {(key: string, options?: object) => string} props.t
 */
export function CallEndingPanel({ config, onChange, t, labelClass, helpClass, inputClass }) {
  const { autoEndCalls, endCallDelaySeconds } = normalizeCallEnding(config);
  const seconds = Array.from({ length: END_DELAY_SECONDS.max - END_DELAY_SECONDS.min + 1 }, (_, i) => END_DELAY_SECONDS.min + i);

  return (
    <fieldset className="flex flex-col gap-3 rounded border border-gray-200 p-3" data-testid="call-ending-panel">
      <legend className="px-1 text-sm font-medium">{t("dashboard:callEnding.title")}</legend>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={autoEndCalls} onChange={(e) => onChange({ autoEndCalls: e.target.checked })} />
        <span>
          <span className="font-medium">{t("dashboard:callEnding.autoEnd")}</span>
          <span className={`block ${helpClass}`}>{t(autoEndCalls ? "dashboard:callEnding.autoEndHelp" : "dashboard:callEnding.offHelp")}</span>
        </span>
      </label>
      {autoEndCalls && (
        <div className="max-w-xs">
          <label className={labelClass} htmlFor="call-ending-delay">{t("dashboard:callEnding.delay")}</label>
          <select id="call-ending-delay" className={inputClass} value={endCallDelaySeconds}
            onChange={(e) => onChange({ endCallDelaySeconds: Number(e.target.value) })}>
            {seconds.map((n) => (
              <option key={n} value={n}>{t("dashboard:callEnding.seconds", { count: n })}</option>
            ))}
          </select>
          <p className={helpClass}>{t("dashboard:callEnding.delayHelp")}</p>
        </div>
      )}
    </fieldset>
  );
}
