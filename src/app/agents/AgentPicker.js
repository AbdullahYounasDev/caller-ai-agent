"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * "WHICH AGENT" — the bar above the console's tabs (CLAUDE.md §6.27). A tenant has one or more
 * agents (a branch, a line, a client); every tab below — settings, what it collects, calls,
 * chat — shows the one picked here. The knowledge library is shared by all of them.
 *
 * Lists /api/agents, and changes agents through POST /api/agents (a new agent starts as a copy
 * of the one being looked at) and PATCH /api/agents/:id (rename, make default, archive,
 * restore). Every word comes from the translations; the server re-checks every rule and its
 * refusals are shown as they come back.
 *
 * @param {object} props
 * @param {string} props.tenantId
 * @param {string} props.uiLocale
 * @param {string|null} props.value               the selected agent id; null = the default agent
 *                                                 of a tenant that has not saved anything yet
 * @param {(agentId: string|null) => void} props.onChange
 * @param {number} [props.refreshKey]             bump to re-read the list (e.g. after a save renames the business)
 * @param {(key: string, options?: object) => string} props.t
 * @param {string} props.cardClass @param {string} props.inputClass @param {string} props.buttonClass @param {string} props.helpClass
 */
export function AgentPicker({ tenantId, uiLocale, value, onChange, refreshKey = 0, t, cardClass, inputClass, buttonClass, helpClass }) {
  const [agents, setAgents] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [mode, setMode] = useState(null); // null | "create" | "rename"
  const [nameText, setNameText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const [reloads, setReloads] = useState(0);

  const base = `tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/agents?${base}${showArchived ? "&includeArchived=1" : ""}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "failed");
        if (cancelled) return;
        setAgents(data.agents);
        // Report the choice on every load, even when it is unchanged: the console waits for it
        // before loading settings (null is a real choice — an unsaved default agent). Nothing
        // picked yet, or the picked agent is gone (another tenant, archived and hidden): the
        // default agent, which the list always has first.
        if (data.agents.length) onChange(data.agents.some((a) => a.id === value) ? value : data.agents[0].id ?? null);
      } catch (err) {
        if (!cancelled) setStatus(String(err.message || err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, showArchived, refreshKey, reloads, value, onChange]);

  const current = agents.find((a) => a.id === value) ?? null;
  const labelOf = (a) => a.name || a.businessName;

  async function send(url, method, body) {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReloads((n) => n + 1);
      return data.agent;
    } catch (err) {
      setStatus(String(err.message || err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submitName(e) {
    e.preventDefault();
    if (mode === "create") {
      const agent = await send(`/api/agents?${base}`, "POST", { name: nameText, copyFrom: value });
      if (agent) {
        setMode(null);
        onChange(agent.id);
        setStatus(t("dashboard:agents.created"));
      }
    } else if (mode === "rename" && current) {
      const agent = await send(`/api/agents/${current.id}?${base}`, "PATCH", { name: nameText });
      if (agent) setMode(null);
    }
  }

  const patchCurrent = (body) => current && send(`/api/agents/${current.id}?${base}`, "PATCH", body);

  return (
    <section className={`${cardClass} flex flex-col gap-2`} data-testid="agent-picker">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <label className="mb-1 block text-sm font-medium" htmlFor="agent-pick">{t("dashboard:agents.label")}</label>
          <select id="agent-pick" className={inputClass} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={busy}>
            {agents.map((a) => (
              <option key={a.id ?? "unsaved"} value={a.id ?? ""}>
                {labelOf(a)}
                {a.isDefault ? ` · ${t("dashboard:agents.default")}` : ""}
                {a.status === "archived" ? ` · ${t("dashboard:agents.archivedTag")}` : ""}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => { setMode("create"); setNameText(""); }}>
          {t("dashboard:agents.new")}
        </button>
        {current?.id && (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => { setMode("rename"); setNameText(current.name); }}>
            {t("dashboard:agents.rename")}
          </button>
        )}
        {current && !current.isDefault && current.status === "active" && (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => patchCurrent({ makeDefault: true })}>
            {t("dashboard:agents.makeDefault")}
          </button>
        )}
        {current && !current.isDefault && current.status === "active" && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => window.confirm(t("dashboard:agents.archiveConfirm", { vars: { name: labelOf(current) } })) && patchCurrent({ status: "archived" })}
          >
            {t("dashboard:agents.archive")}
          </button>
        )}
        {current?.status === "archived" && (
          <button type="button" className={buttonClass} disabled={busy} onClick={() => patchCurrent({ status: "active" })}>
            {t("dashboard:agents.restore")}
          </button>
        )}
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t("dashboard:agents.showArchived")}
        </label>
      </div>

      {mode && (
        <form onSubmit={submitName} className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label className="mb-1 block text-sm font-medium" htmlFor="agent-name">
              {t(mode === "create" ? "dashboard:agents.newName" : "dashboard:agents.renameLabel")}
            </label>
            <input id="agent-name" className={inputClass} value={nameText} maxLength={60} autoFocus
              placeholder={t("dashboard:agents.namePlaceholder")} onChange={(e) => setNameText(e.target.value)} />
          </div>
          <button type="submit" className={buttonClass} disabled={busy}>{t(mode === "create" ? "common:action.create" : "common:action.save")}</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => setMode(null)}>{t("common:action.cancel")}</button>
        </form>
      )}

      <p className={helpClass}>
        {mode === "create" && current
          ? t("dashboard:agents.copyHelp", { vars: { name: labelOf(current) } })
          : current?.status === "archived"
            ? t("dashboard:agents.archivedHelp")
            : t("dashboard:agents.help")}
      </p>
      {status && <p className="text-sm">{status}</p>}
    </section>
  );
}
