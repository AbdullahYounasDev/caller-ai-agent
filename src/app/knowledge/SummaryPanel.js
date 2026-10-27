"use client";

import { SUMMARY_MAX_CHARS, summaryProblems } from "@/lib/agent/summary-rules";

/**
 * THE BUSINESS SUMMARY in the Agent tab (CLAUDE.md §6.20): what the agent always knows about the
 * business, written by the AI from documents the owner chose (Knowledge tab → "Summarize for the
 * agent") and approved by the owner. Editable here and saved with the Agent tab's own Save button;
 * cleared with "Remove". Says which documents it came from, and when one of them has changed or
 * gone since — the owner then summarises again.
 *
 * @param {object} props
 * @param {object} props.config          the agent (profileSummary, profileSummarySources)
 * @param {{stale: boolean, changed: string[], missing: string[]}|null} props.status  from GET /api/agent-config
 * @param {(patch: {profileSummary: string}) => void} props.onChange
 * @param {(key: string, options?: object) => string} props.t
 */
export function SummaryPanel({ config, status, onChange, t, labelClass, helpClass, inputClass }) {
  const text = config.profileSummary ?? "";
  const sources = Array.isArray(config.profileSummarySources) ? config.profileSummarySources : [];
  const problems = summaryProblems(text);
  const urdu = /[؀-ۿ]/.test(text);

  return (
    <fieldset className="flex flex-col gap-2 rounded border border-gray-200 p-3" data-testid="summary-panel">
      <legend className="px-1 text-sm font-medium">{t("dashboard:summary.title")}</legend>
      <p className={helpClass}>{t("dashboard:summary.help")}</p>
      {!text && !sources.length ? (
        <p className="rounded bg-gray-50 px-2 py-1 text-sm text-gray-600" data-testid="summary-empty">{t("dashboard:summary.empty")}</p>
      ) : (
        <>
          <label className={labelClass} htmlFor="profile-summary">{t("dashboard:summary.label")}</label>
          <textarea
            id="profile-summary"
            className={`${inputClass} min-h-28`}
            dir={urdu ? "rtl" : "ltr"}
            value={text}
            onChange={(e) => onChange({ profileSummary: e.target.value })}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
            <span>{sources.length ? t("dashboard:summary.from", { vars: { documents: sources.map((s) => s.title).join(", ") } }) : ""}</span>
            <span>
              <span className={text.length > SUMMARY_MAX_CHARS ? "text-red-600" : ""}>{text.length}/{SUMMARY_MAX_CHARS}</span>
              {text && (
                <button type="button" className="ms-2 underline" onClick={() => onChange({ profileSummary: "" })}>
                  {t("dashboard:summary.remove")}
                </button>
              )}
            </span>
          </div>
        </>
      )}
      {problems.map((p) => (
        <p key={p.code} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {t(`validation:summary.${p.code}`, p.vars ? { vars: p.vars } : undefined)}
        </p>
      ))}
      {status?.changed?.length > 0 && (
        <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800" data-testid="summary-stale">
          {t("dashboard:summary.stale", { vars: { documents: status.changed.join(", ") } })}
        </p>
      )}
      {status?.missing?.length > 0 && (
        <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {t("dashboard:summary.missing", { vars: { documents: status.missing.join(", ") } })}
        </p>
      )}
    </fieldset>
  );
}
