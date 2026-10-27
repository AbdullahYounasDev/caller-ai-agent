"use client";

import { SUMMARY_MAX_CHARS, summaryProblems } from "@/lib/agent/summary-rules";

/**
 * THE AI'S DRAFT OF THE BUSINESS SUMMARY, for the owner to check before it is saved
 * (CLAUDE.md §6.20, POST /api/agent-config/summary). Shown in the Knowledge tab's modal after the
 * owner ticked the documents that describe the business and pressed "Summarize for the agent".
 *
 * The owner can change every word. What it was written from, what was not used (and why) and the
 * sentences removed because they named a price are all shown, so nothing about the draft is hidden.
 * A price typed back in is flagged here with the same rule the server refuses it with.
 *
 * @param {object} props
 * @param {{loading?: boolean, saving?: boolean, error?: string|null, ids: string[], text?: string,
 *          sources?: Array<{id: string, title: string}>, skipped?: Array<{title: string|null, reason: string}>,
 *          removed?: string[]}} props.state
 * @param {(text: string) => void} props.onChange
 * @param {() => void} props.onSave
 * @param {() => void} props.onCancel
 * @param {boolean} props.replacing   the agent already has a summary
 * @param {(key: string, options?: object) => string} props.t
 * @param {"en"|"ur"} props.language  the draft's language
 */
export function SummaryDraft({ state, onChange, onSave, onCancel, replacing, t, language, inputClass, helpClass }) {
  if (state.loading) {
    return <p className="text-sm text-gray-600" data-testid="summary-writing">{t("dashboard:summary.writing", { count: state.ids.length })}</p>;
  }
  if (!state.sources?.length) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-red-600">{state.error}</p>
        <div>
          <button type="button" onClick={onCancel} className="rounded border border-gray-300 px-4 py-2 text-sm">{t("common:action.close")}</button>
        </div>
      </div>
    );
  }

  const text = state.text ?? "";
  const problems = summaryProblems(text);
  const rtl = language === "ur";
  return (
    <div className="flex flex-col gap-3" data-testid="summary-draft">
      <p className={helpClass}>{t("dashboard:summary.reviewHelp")}</p>
      <textarea
        className={`${inputClass} min-h-40`}
        dir={rtl ? "rtl" : "ltr"}
        lang={language}
        maxLength={SUMMARY_MAX_CHARS + 200}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("dashboard:summary.title")}
      />
      <div className="flex flex-wrap justify-between gap-2 text-xs text-gray-500">
        <span>{t("dashboard:summary.from", { vars: { documents: state.sources.map((s) => s.title).join(", ") } })}</span>
        <span className={text.length > SUMMARY_MAX_CHARS ? "text-red-600" : ""}>{text.length}/{SUMMARY_MAX_CHARS}</span>
      </div>
      {problems.map((p) => (
        <p key={p.code} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800" data-testid={`summary-problem-${p.code}`}>
          {t(`validation:summary.${p.code}`, p.vars ? { vars: p.vars } : undefined)}
        </p>
      ))}
      {state.removed?.length > 0 && (
        <div className="rounded border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-600" data-testid="summary-removed">
          <p className="font-medium">{t("dashboard:summary.removed")}</p>
          <ul className="ms-4 list-disc">
            {state.removed.map((sentence) => <li key={sentence}>{sentence}</li>)}
          </ul>
        </div>
      )}
      {state.skipped?.length > 0 && (
        <div className="text-xs text-gray-500">
          <p>{t("dashboard:summary.skipped")}</p>
          <ul className="ms-4 list-disc">
            {state.skipped.map((s, i) => <li key={`${s.title}-${i}`}>{t(`dashboard:summary.skip.${s.reason}`, { vars: { title: s.title ?? "" } })}</li>)}
          </ul>
        </div>
      )}
      {replacing && <p className="text-xs text-gray-500">{t("dashboard:summary.replaces")}</p>}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onSave} disabled={state.saving || !text.trim() || problems.length > 0} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40">
          {state.saving ? t("common:state.saving") : t("dashboard:summary.save")}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-gray-300 px-4 py-2 text-sm">{t("common:action.cancel")}</button>
      </div>
    </div>
  );
}
