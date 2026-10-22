"use client";

import { useCallback, useEffect, useState } from "react";
import { EventTimeline } from "./EventTimeline";
import { TurnMeta } from "./TurnMeta";
import { formatDuration, formatMs } from "./format";

/**
 * RECENT CALLS — read back from the database, so this is the proof that everything the
 * live panel showed was actually stored: per call the summary, and on click its full
 * transcript with each turn's intent, outcome, sources and timings, plus the timeline.
 */
export function CallHistory({ tenantId, agentId, t, refreshKey }) {
  const [calls, setCalls] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const load = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/voice/calls?tenantId=${encodeURIComponent(tenantId)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}&limit=10`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (cancelled) return;
        setCalls(data.calls);
        setFailed(false);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [tenantId, agentId, refreshKey, reloads]);

  async function toggle(id) {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setDetail(null);
    try {
      const res = await fetch(`/api/voice/calls/${id}?tenantId=${encodeURIComponent(tenantId)}`);
      if (res.ok) setDetail(await res.json());
    } catch {
      // the row simply stays without detail
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("dashboard:voice.history.title")}</h3>
        <button type="button" onClick={load} className="text-xs text-gray-500 underline-offset-2 hover:underline">
          {t("common:action.reload")}
        </button>
      </div>

      {failed && <p className="text-xs text-red-600">{t("dashboard:errors.generic")}</p>}
      {calls?.length === 0 && <p className="text-xs text-gray-400">{t("dashboard:voice.history.empty")}</p>}

      <ul className="flex flex-col divide-y divide-gray-100 rounded border border-gray-200">
        {calls?.map((call) => (
          <li key={call.id}>
            <button
              type="button"
              onClick={() => toggle(call.id)}
              className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-start text-xs hover:bg-gray-50"
            >
              <span className="font-medium text-gray-800">{new Date(call.createdAt).toLocaleString()}</span>
              <span>{formatDuration(call.durationSec)}</span>
              <span>{t("dashboard:voice.history.turns", { count: call.turnCount })}</span>
              <span>{t("dashboard:voice.history.median", { vars: { time: formatMs(call.medianResponseMs) } })}</span>
              {call.unanswered > 0 && (
                <span className="text-amber-700">{t("dashboard:voice.history.unanswered", { count: call.unanswered })}</span>
              )}
              {call.interruptions > 0 && (
                <span className="text-purple-700">{t("dashboard:voice.history.interruptions", { count: call.interruptions })}</span>
              )}
              <span className="ms-auto text-gray-400">
                {call.status === "active"
                  ? t("dashboard:voice.history.active")
                  : t(`dashboard:voice.endReason.${call.endReason ?? "disconnected"}`)}
              </span>
            </button>

            {openId === call.id && (
              <div className="flex flex-col gap-3 border-t border-gray-100 bg-gray-50 px-3 py-3">
                {!detail ? (
                  <p className="text-xs text-gray-400">{t("common:state.loading")}</p>
                ) : (
                  <>
                    {detail.turns.length === 0 && (
                      <p className="text-xs text-gray-400">{t("dashboard:voice.history.noTurns")}</p>
                    )}
                    {detail.turns.map((turn) => (
                      <div key={turn.id} className="flex flex-col gap-1 text-sm">
                        <p>
                          <span className="text-xs text-gray-400">{t("dashboard:voice.caller")}: </span>
                          {turn.callerText}
                        </p>
                        <p>
                          <span className="text-xs text-gray-400">{t("dashboard:voice.agent")}: </span>
                          {turn.agentText}
                        </p>
                        <TurnMeta meta={turn} t={t} />
                      </div>
                    ))}
                    <details>
                      <summary className="cursor-pointer text-xs text-gray-500">{t("dashboard:voice.log.title")}</summary>
                      <div className="mt-2">
                        <EventTimeline events={detail.events} t={t} />
                      </div>
                    </details>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
