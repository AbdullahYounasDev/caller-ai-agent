/**
 * Small display helpers shared by the live call panel and the call history.
 * Pure — no React, no i18n — so both views format numbers identically.
 */

/** 1234 → "1.23 s", 640 → "640 ms", null → "—" */
export function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

/** 83 → "1:23" */
export function formatDuration(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "—";
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** An event's payload as compact "key=value" pairs for the timeline. */
export function formatEventData(data) {
  if (!data || typeof data !== "object") return "";
  return Object.entries(data)
    .filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("  ");
}

/** Tailwind classes for an outcome chip — the colour IS the meaning at a glance. */
export function outcomeClass(outcome) {
  switch (outcome) {
    case "answered":
      return "bg-green-50 text-green-700 ring-green-200";
    case "no_knowledge":
      return "bg-amber-50 text-amber-800 ring-amber-200";
    case "handoff_requested":
      return "bg-blue-50 text-blue-700 ring-blue-200";
    case "failed":
      return "bg-red-50 text-red-700 ring-red-200";
    default:
      return "bg-gray-50 text-gray-600 ring-gray-200";
  }
}

/** The per-stage timings worth showing, in pipeline order. */
export const STAGES = ["sttMs", "retrievalMs", "llmFirstTokenMs", "ttsFirstAudioMs"];
