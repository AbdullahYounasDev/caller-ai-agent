"use client";

import { useState } from "react";

/**
 * "WHO USES THIS DOCUMENT" — one row's availability in the Knowledge tab (CLAUDE.md §6.28).
 *
 * Shows whether the document is shared with every agent or limited to some, and lets the owner
 * change it. Saving sends PUT /api/knowledge/:id { agents } — the server re-checks every id and
 * nothing is re-embedded (the text did not change, only who may retrieve it). Every word comes
 * from the translations.
 *
 * @param {object} props
 * @param {{id: string, agents: string[]|null}} props.doc
 * @param {Array<{id: string|null, name: string, businessName: string, status: string}>} props.agents the tenant's agents (archived included, for names)
 * @param {(agents: string[]|null) => Promise<boolean>} props.onSave resolves true when saved
 * @param {boolean} props.busy
 * @param {(key: string, options?: object) => string} props.t
 */
export function DocumentAgents({ doc, agents, onSave, busy, t }) {
  const [editing, setEditing] = useState(false);
  const [shared, setShared] = useState(doc.agents === null);
  const [picked, setPicked] = useState(() => new Set(doc.agents ?? []));

  const nameOf = (id) => {
    const a = agents.find((x) => x.id === id);
    if (!a) return t("dashboard:knowledgeAgents.unknownAgent");
    const label = a.name || a.businessName;
    return a.status === "archived" ? `${label} (${t("dashboard:agents.archivedTag")})` : label;
  };
  // Only agents with an id can be chosen (an unsaved default has none yet); archived ones are not
  // offered, but an existing link to one stays visible in the summary.
  const choosable = agents.filter((a) => a.id && a.status === "active");
  const onlyArchived = doc.agents?.length && doc.agents.every((id) => agents.find((a) => a.id === id)?.status === "archived");

  const summary =
    doc.agents === null
      ? t("dashboard:knowledgeAgents.shared")
      : t("dashboard:knowledgeAgents.only", { vars: { names: doc.agents.map(nameOf).join(", ") } });

  function open() {
    setShared(doc.agents === null);
    setPicked(new Set(doc.agents ?? []));
    setEditing(true);
  }

  async function save() {
    const ok = await onSave(shared ? null : [...picked]);
    if (ok) setEditing(false);
  }

  if (!editing) {
    return (
      <span className="flex flex-wrap items-center gap-1 text-xs">
        <span className={doc.agents === null ? "text-gray-500" : "text-blue-600"}>{summary}</span>
        {onlyArchived && <span className="text-amber-600">· {t("dashboard:knowledgeAgents.nobodyActive")}</span>}
        {choosable.length > 1 && (
          <button type="button" className="underline" disabled={busy} onClick={open}>
            {t("dashboard:knowledgeAgents.change")}
          </button>
        )}
      </span>
    );
  }

  return (
    <div className="mt-1 flex w-full flex-col gap-1 rounded border border-gray-300 p-2 text-xs" data-testid="document-agents">
      <label className="flex items-center gap-2">
        <input type="radio" checked={shared} onChange={() => setShared(true)} />
        {t("dashboard:knowledgeAgents.allOption")}
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" checked={!shared} onChange={() => setShared(false)} />
        {t("dashboard:knowledgeAgents.someOption")}
      </label>
      {!shared && (
        <div className="ms-6 flex flex-col gap-1">
          {choosable.map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={picked.has(a.id)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(a.id);
                    else next.delete(a.id);
                    return next;
                  })
                }
              />
              {a.name || a.businessName}
            </label>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button type="button" className="rounded border border-gray-300 px-2 py-1" disabled={busy || (!shared && picked.size === 0)} onClick={save}>
          {t("common:action.save")}
        </button>
        <button type="button" className="rounded border border-gray-300 px-2 py-1" disabled={busy} onClick={() => setEditing(false)}>
          {t("common:action.cancel")}
        </button>
      </div>
      <p className="text-gray-500">{t("dashboard:knowledgeAgents.help")}</p>
    </div>
  );
}
