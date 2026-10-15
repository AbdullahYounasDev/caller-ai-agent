"use client";

import { formatMs, outcomeClass, STAGES } from "./format";

/**
 * What a turn was about and how fast it was — shown under an agent reply, both live and
 * in the call history: intent · outcome, time to first audio, the documents it came
 * from, and where the time went.
 */
export function TurnMeta({ meta, t }) {
  if (!meta) return null;
  const timings = meta.timings ?? {};
  const sources = Array.isArray(meta.sources) ? meta.sources : [];

  return (
    <div className="mt-1 flex flex-col gap-1 text-xs text-gray-500">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">{t(`dashboard:voice.intent.${meta.intent}`)}</span>
        <span className={`rounded px-1.5 py-0.5 ring-1 ring-inset ${outcomeClass(meta.outcome)}`}>
          {t(`dashboard:voice.outcome.${meta.outcome}`)}
        </span>
        {timings.responseMs != null && (
          <span className="font-medium text-gray-700">
            {t("dashboard:voice.responseTime", { vars: { time: formatMs(timings.responseMs) } })}
          </span>
        )}
        {meta.interrupted && (
          <span className="rounded bg-purple-50 px-1.5 py-0.5 text-purple-700 ring-1 ring-inset ring-purple-200">
            {t("dashboard:voice.interrupted")}
          </span>
        )}
      </div>
      <div>
        {sources.length
          ? t("dashboard:voice.groundedIn", { vars: { sources: sources.join(", ") } })
          : t("dashboard:voice.noSources")}
        {meta.searchQuery && <> · {t("dashboard:voice.searchedFor", { vars: { query: meta.searchQuery } })}</>}
      </div>
      <div className="font-mono text-[11px] text-gray-400">
        {STAGES.map((stage) => `${t(`dashboard:voice.stage.${stage}`)} ${formatMs(timings[stage])}`).join("  ·  ")}
      </div>
    </div>
  );
}
