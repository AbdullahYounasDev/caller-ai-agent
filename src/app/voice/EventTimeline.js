"use client";

import { useEffect, useRef } from "react";
import { formatEventData } from "./format";

/**
 * A call's timeline — every event from call_events, in order, with its offset from the
 * moment the call was answered. The same component renders the live log and a past
 * call's log, so what you watched live is exactly what was stored.
 */
export function EventTimeline({ events, t, follow = false }) {
  const end = useRef(null);
  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "nearest" });
  }, [events.length, follow]);

  if (!events.length) return <p className="text-xs text-gray-400">{t("dashboard:voice.log.empty")}</p>;

  return (
    <ol dir="ltr" className="max-h-64 overflow-y-auto rounded bg-gray-950 p-3 font-mono text-[11px] leading-5 text-gray-200">
      {events.map((e) => (
        <li key={e.seq} className="flex gap-3 whitespace-pre-wrap">
          <span className="shrink-0 text-gray-500">+{(e.atMs / 1000).toFixed(2)}s</span>
          <span className={`shrink-0 ${eventColor(e.type)}`}>{e.type}</span>
          <span className="text-gray-400">{formatEventData(e.data)}</span>
        </li>
      ))}
      <li ref={end} aria-hidden />
    </ol>
  );
}

function eventColor(type) {
  if (type.endsWith("failed")) return "text-red-400";
  if (type.startsWith("playback.interrupted")) return "text-purple-300";
  if (type.startsWith("call.")) return "text-sky-300";
  if (type.startsWith("turn.")) return "text-green-300";
  return "text-amber-200";
}
