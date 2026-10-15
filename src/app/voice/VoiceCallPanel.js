"use client";

import { useEffect, useRef, useState } from "react";
import { CALL_STATES } from "@/lib/voice/protocol";
import { useVoiceCall } from "./useVoiceCall";
import { TurnMeta } from "./TurnMeta";
import { EventTimeline } from "./EventTimeline";
import { CallHistory } from "./CallHistory";
import { formatDuration } from "./format";

/**
 * THE VOICE CALL PANEL — call your own agent from the test console.
 *
 * Press Call → allow the microphone → the agent greets you → talk. Everything a turn
 * does is visible: what you said (as the agent heard it), what it answered, which
 * documents it answered from, what it took you to be asking (intent / outcome), how
 * long you waited, and the call's full timeline. Below, the same information read back
 * from the database for recent calls.
 *
 * Same standing as the chat panel: a test surface for the same brain a phone call will
 * use, not a product channel (§2).
 */
export function VoiceCallPanel({ tenantId, uiLocale, t, dir, cardClass }) {
  const call = useVoiceCall({ tenantId, uiLocale });
  const [historyKey, setHistoryKey] = useState(0);
  const busy = call.status === "preparing" || call.status === "live";

  // Refresh the history once a call has ended and its record has been written.
  useEffect(() => {
    if (call.status === "ended") {
      const timer = setTimeout(() => setHistoryKey((k) => k + 1), 600);
      return () => clearTimeout(timer);
    }
  }, [call.status]);

  // A different business is a different line: never keep a call open across the switch.
  const { hangup } = call;
  useEffect(() => () => hangup(), [tenantId, hangup]);

  return (
    <section className={`${cardClass} flex flex-col gap-4`} dir={dir}>
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">{t("common:channel.voice")}</h2>
          <StatusPill call={call} t={t} />
        </div>
        <p className="mt-1 text-xs text-gray-500">{t("dashboard:voice.help")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {!busy ? (
          <button
            type="button"
            onClick={call.start}
            className="flex items-center gap-2 rounded-full bg-green-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-green-700"
          >
            <PhoneIcon />
            {t("dashboard:voice.call")}
          </button>
        ) : (
          <button
            type="button"
            onClick={call.hangup}
            className="flex items-center gap-2 rounded-full bg-red-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-red-700"
          >
            <PhoneIcon down />
            {t("dashboard:voice.end")}
          </button>
        )}

        {call.status === "live" && (
          <button
            type="button"
            onClick={call.toggleMute}
            aria-pressed={call.muted}
            className={`rounded-full border px-4 py-2 text-sm ${call.muted ? "border-amber-300 bg-amber-50 text-amber-800" : "border-gray-300"}`}
          >
            {call.muted ? t("dashboard:voice.unmute") : t("dashboard:voice.mute")}
          </button>
        )}

        {call.status === "live" && <CallTimer startedAt={call.startedAt} />}

        {call.status === "live" && (
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <LevelBar label={t("dashboard:voice.you")} levels={call.levels} which="mic" color="bg-gray-800" />
            <LevelBar label={t("dashboard:voice.agent")} levels={call.levels} which="agent" color="bg-green-500" />
          </div>
        )}
      </div>

      {call.status === "error" && (
        <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {call.notice && call.error === "refused" ? call.notice : t(`dashboard:voice.error.${call.error ?? "refused"}`)}
        </p>
      )}
      {call.status === "live" && call.notice === "turnFailed" && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("dashboard:voice.error.turnFailed")}
        </p>
      )}
      {call.status === "ended" && call.endReason && (
        <p className="text-xs text-gray-500">
          {t("dashboard:voice.endedBecause", { vars: { reason: t(`dashboard:voice.endReason.${call.endReason}`) } })}
        </p>
      )}
      {call.status !== "live" && <p className="text-xs text-gray-400">{t("dashboard:voice.headphonesHint")}</p>}

      {(call.transcript.length > 0 || call.status === "live") && (
        <div className="flex max-h-96 min-h-24 flex-col gap-2 overflow-y-auto">
          {call.transcript.map((m, i) => (
            <div key={i} className={m.role === "caller" ? "max-w-[85%] self-end" : "max-w-[85%] self-start"}>
              {m.text && (
                <div
                  className={
                    m.role === "caller"
                      ? "rounded bg-black px-3 py-2 text-sm text-white"
                      : "rounded bg-gray-100 px-3 py-2 text-sm text-black"
                  }
                >
                  {m.text}
                </div>
              )}
              {m.role === "agent" && <TurnMeta meta={m.meta} t={t} />}
            </div>
          ))}
        </div>
      )}

      {call.events.length > 0 && (
        <details open={call.status === "live"}>
          <summary className="cursor-pointer text-xs font-medium text-gray-600">
            {t("dashboard:voice.log.title")}
            {call.callId && <span className="ms-2 font-mono text-gray-400">{call.callId}</span>}
          </summary>
          <div className="mt-2">
            <EventTimeline events={call.events} t={t} follow />
          </div>
        </details>
      )}

      <CallHistory tenantId={tenantId} t={t} refreshKey={historyKey} />
    </section>
  );
}

function StatusPill({ call, t }) {
  const label =
    call.status === "live"
      ? t(`dashboard:voice.state.${call.callState}`)
      : t(`dashboard:voice.status.${call.status}`);
  const dot =
    call.status !== "live"
      ? call.status === "error"
        ? "bg-red-500"
        : call.status === "preparing"
          ? "bg-amber-400 animate-pulse"
          : "bg-gray-300"
      : {
          [CALL_STATES.LISTENING]: "bg-green-500",
          [CALL_STATES.HEARING]: "bg-green-500 animate-pulse",
          [CALL_STATES.THINKING]: "bg-amber-400 animate-pulse",
          [CALL_STATES.SPEAKING]: "bg-blue-500 animate-pulse",
        }[call.callState] ?? "bg-gray-300";

  return (
    <span className="flex items-center gap-2 rounded-full border border-gray-200 px-3 py-1 text-xs" role="status">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function CallTimer({ startedAt }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setSeconds((Date.now() - startedAt) / 1000), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  return <span className="font-mono text-sm tabular-nums text-gray-600">{formatDuration(seconds)}</span>;
}

/** A live level meter. Reads the hook's level ref on every animation frame and writes the
 *  width straight to the DOM — 60 updates a second through React state would re-render
 *  the whole panel for nothing. */
function LevelBar({ label, levels, which, color }) {
  const bar = useRef(null);
  useEffect(() => {
    let frame;
    const draw = () => {
      const level = Math.min(1, (levels.current[which] ?? 0) * 6);
      if (bar.current) bar.current.style.width = `${Math.round(level * 100)}%`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levels, which]);

  return (
    <div className="flex items-center gap-2 text-[11px] text-gray-500">
      <span className="w-12 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-gray-100">
        <div ref={bar} className={`h-full w-0 rounded ${color} transition-[width] duration-75`} />
      </div>
    </div>
  );
}

function PhoneIcon({ down = false }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden style={down ? { transform: "rotate(135deg)" } : undefined}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
