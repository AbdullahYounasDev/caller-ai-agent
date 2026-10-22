"use client";

import { useState } from "react";

/**
 * PHONE NUMBERS — the console's "Numbers" tab (CLAUDE.md §6.29).
 *
 * Lists the business's numbers and which agent each one rings, and lets the owner add one, link
 * it to another agent, rename it or release it. Buying numbers is the backend's (handoff B11):
 * this screen stands in for its dashboard, over the stand-in store (/api/numbers), so the routing
 * can be tried end to end today — "Try the lookup" runs exactly what a real call will.
 *
 * Every word comes from the translations; the server re-checks every rule and its refusals are
 * shown as they come back.
 *
 * @param {object} props
 * @param {string} props.tenantId
 * @param {string} props.uiLocale
 * @param {object[]} props.numbers          active numbers (from the parent, which also feeds the Call tab)
 * @param {object[]} props.agents           every agent of the tenant (AgentPicker)
 * @param {() => Promise<void>} props.onChanged re-read the numbers after a change
 * @param {(key: string, options?: object) => string} props.t
 */
export function NumbersPanel({ tenantId, uiLocale, numbers, agents, onChanged, t, cardClass, inputClass, buttonClass, helpClass, labelClass }) {
  const [form, setForm] = useState({ e164: "", label: "", agentId: "", kind: "purchased" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [lookup, setLookup] = useState({ to: "", result: null });

  const base = `tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`;
  // Only agents that can answer may be linked; an unsaved default (no id) cannot be either.
  const linkable = agents.filter((a) => a.id && a.status === "active");
  const agentName = (id) => {
    const a = agents.find((x) => x.id === id);
    return a ? a.name || a.businessName : t("dashboard:numbers.noAgent");
  };

  async function send(url, method, body) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await onChanged();
      return data;
    } catch (err) {
      setStatus(String(err.message || err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function add(e) {
    e.preventDefault();
    const done = await send(`/api/numbers?${base}`, "POST", { ...form, agentId: form.agentId || null });
    if (done) {
      setForm({ e164: "", label: "", agentId: "", kind: "purchased" });
      setStatus(t("dashboard:numbers.added"));
    }
  }

  async function tryLookup(e) {
    e.preventDefault();
    setLookup((prev) => ({ ...prev, result: null }));
    const res = await fetch(`/api/numbers/lookup?to=${encodeURIComponent(lookup.to)}&locale=${uiLocale}`);
    const data = await res.json().catch(() => ({}));
    setLookup((prev) => ({ ...prev, result: res.ok ? data : { ok: false, reason: "invalid_number" } }));
  }

  return (
    <section className={`${cardClass} flex flex-col gap-4`} data-testid="numbers-panel">
      <div>
        <h2 className="font-medium">{t("dashboard:numbers.title")}</h2>
        <p className={helpClass}>{t("dashboard:numbers.help")}</p>
      </div>

      {numbers.length === 0 ? (
        <p className="text-sm text-gray-400">{t("dashboard:numbers.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-gray-200 border-y border-gray-200">
          {numbers.map((n) => (
            <li key={n.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <div className="min-w-40 flex-1">
                <p className="font-medium" dir="ltr">{n.e164}</p>
                <p className="text-xs text-gray-500">
                  {n.label || t("dashboard:numbers.unlabelled")} · {t(`dashboard:numbers.kind.${n.kind}`)}
                </p>
                {!n.agentId && <p className="text-xs text-amber-700">{t("dashboard:numbers.unlinked")}</p>}
              </div>
              <label className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{t("dashboard:numbers.rings")}</span>
                <select
                  className="rounded border border-gray-300 px-2 py-1"
                  value={n.agentId ?? ""}
                  disabled={busy}
                  onChange={(e) => send(`/api/numbers/${n.id}?${base}`, "PATCH", { agentId: e.target.value || null })}
                >
                  <option value="">{t("dashboard:numbers.noAgent")}</option>
                  {/* An agent archived since stays visible as the current value. */}
                  {n.agentId && !linkable.some((a) => a.id === n.agentId) && <option value={n.agentId}>{agentName(n.agentId)}</option>}
                  {linkable.map((a) => (
                    <option key={a.id} value={a.id}>{a.name || a.businessName}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => window.confirm(t("dashboard:numbers.releaseConfirm", { vars: { number: n.e164 } })) && send(`/api/numbers/${n.id}?${base}`, "PATCH", { status: "released" })}
              >
                {t("dashboard:numbers.release")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="flex flex-col gap-2">
        <span className={labelClass}>{t("dashboard:numbers.addTitle")}</span>
        <div className="flex flex-wrap gap-2">
          <input className={`${inputClass} min-w-44 flex-1`} dir="ltr" placeholder="+44 20 7123 4567" value={form.e164}
            onChange={(e) => setForm({ ...form, e164: e.target.value })} aria-label={t("dashboard:numbers.number")} />
          <input className={`${inputClass} min-w-40 flex-1`} placeholder={t("dashboard:numbers.labelPlaceholder")} value={form.label} maxLength={60}
            onChange={(e) => setForm({ ...form, label: e.target.value })} aria-label={t("dashboard:numbers.label")} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="rounded border border-gray-300 px-2 py-1 text-sm" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}
            aria-label={t("dashboard:numbers.rings")}>
            <option value="">{t("dashboard:numbers.noAgent")}</option>
            {linkable.map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.businessName}</option>
            ))}
          </select>
          <select className="rounded border border-gray-300 px-2 py-1 text-sm" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}
            aria-label={t("dashboard:numbers.kindLabel")}>
            <option value="purchased">{t("dashboard:numbers.kind.purchased")}</option>
            <option value="forwarding">{t("dashboard:numbers.kind.forwarding")}</option>
          </select>
          <button type="submit" className={buttonClass} disabled={busy || !form.e164.trim()}>{t("dashboard:numbers.add")}</button>
        </div>
        <p className={helpClass}>{t("dashboard:numbers.addHelp")}</p>
        {linkable.length === 0 && <p className="text-xs text-amber-700">{t("dashboard:numbers.saveAgentFirst")}</p>}
      </form>

      <form onSubmit={tryLookup} className="flex flex-col gap-2 rounded border border-gray-200 p-2">
        <span className={labelClass}>{t("dashboard:numbers.lookupTitle")}</span>
        <div className="flex flex-wrap gap-2">
          <input className={`${inputClass} min-w-44 flex-1`} dir="ltr" placeholder="+44 20 7123 4567" value={lookup.to}
            onChange={(e) => setLookup({ to: e.target.value, result: null })} aria-label={t("dashboard:numbers.number")} />
          <button type="submit" className={buttonClass} disabled={!lookup.to.trim()}>{t("dashboard:numbers.lookupButton")}</button>
        </div>
        {lookup.result && (
          <p className="text-sm" data-testid="lookup-result">
            {lookup.result.ok
              ? lookup.result.tenantId === tenantId
                ? t("dashboard:numbers.lookupOk", { vars: { number: lookup.result.e164, agent: agentName(lookup.result.agentId) } })
                : t("dashboard:numbers.lookupOther", { vars: { number: lookup.result.e164 } })
              : t(`dashboard:numbers.lookupNo.${lookup.result.reason}`)}
          </p>
        )}
        <p className={helpClass}>{t("dashboard:numbers.lookupHelp")}</p>
      </form>

      {status && <p className="text-sm">{status}</p>}
    </section>
  );
}
