"use client";

import { useState } from "react";
import { LIMITS, DEFAULT_AFTER_MISSES, emptyHandoffConfig } from "@/lib/handoff/config";

/**
 * "CALL FORWARDING" — the part of the agent settings where a business says who a caller may be
 * passed to, and when (lib/handoff). The owner switches it on, lists the people in the order
 * they should be tried (a role such as "Senior doctor", a name, a phone number), and chooses
 * how patient the agent is before it hands over.
 *
 * It edits the `escalation` part of the agent settings in place (the Agent tab's own Save
 * button saves it), and everything it shows is read from the translations — there is no text
 * of its own here. The server checks every row again on save (PUT /api/agent-config).
 *
 * @param {object} props
 * @param {object} props.value       config.escalation
 * @param {(next: object) => void} props.onChange
 * @param {(key: string, options?: object) => string} props.t
 * @param {string} props.labelClass @param {string} props.helpClass @param {string} props.inputClass @param {string} props.buttonClass
 */
export function HandoffPanel({ value, onChange, t, labelClass, helpClass, inputClass, buttonClass }) {
  const config = { ...emptyHandoffConfig(), ...(value ?? {}) };
  // Typed as one line ("complaint, refund") but stored as a list; kept as text while typing so a
  // trailing comma is not swallowed.
  const [topicsText, setTopicsText] = useState(() => (config.topics ?? []).join(", "));

  const patch = (changes) => onChange({ ...config, ...changes });
  const setContact = (index, changes) => patch({ contacts: config.contacts.map((c, i) => (i === index ? { ...c, ...changes } : c)) });
  const move = (index, by) => {
    const list = [...config.contacts];
    const target = index + by;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    patch({ contacts: list });
  };

  return (
    <div className="flex flex-col gap-3 rounded border border-gray-300 p-3" data-testid="handoff-panel">
      <div>
        <h3 className="font-medium">{t("dashboard:handoff.title")}</h3>
        <p className={helpClass}>{t("dashboard:handoff.help")}</p>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={config.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        <span>
          {t("dashboard:handoff.enable")}
          <span className="block text-xs text-gray-500">{t("dashboard:handoff.enableHelp")}</span>
        </span>
      </label>

      {config.enabled && (
        <>
          <div>
            <span className={labelClass}>{t("dashboard:handoff.contacts")}</span>
            <p className={`${helpClass} mb-2`}>{t("dashboard:handoff.contactsHelp")}</p>
            <div className="flex flex-col gap-2">
              {config.contacts.map((contact, index) => (
                <div key={contact.id || index} className="flex flex-wrap items-end gap-2 rounded border border-gray-200 p-2">
                  <span className="pb-2 text-xs text-gray-400">{index + 1}</span>
                  <div className="min-w-32 flex-1">
                    <label className="text-xs text-gray-500">{t("dashboard:handoff.role")}</label>
                    <input className={inputClass} value={contact.role} maxLength={LIMITS.textMax} placeholder={t("dashboard:handoff.rolePlaceholder")}
                      onChange={(e) => setContact(index, { role: e.target.value })} />
                  </div>
                  <div className="min-w-32 flex-1">
                    <label className="text-xs text-gray-500">{t("dashboard:handoff.name")}</label>
                    <input className={inputClass} value={contact.name} maxLength={LIMITS.textMax}
                      onChange={(e) => setContact(index, { name: e.target.value })} />
                  </div>
                  <div className="min-w-40 flex-1">
                    <label className="text-xs text-gray-500">{t("dashboard:handoff.phone")}</label>
                    <input className={inputClass} dir="ltr" inputMode="tel" value={contact.phone} placeholder="0300 1234567"
                      onChange={(e) => setContact(index, { phone: e.target.value })} />
                  </div>
                  <div className="flex gap-1 pb-1">
                    <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-30" disabled={index === 0}
                      aria-label={t("dashboard:handoff.moveUp")} onClick={() => move(index, -1)}>↑</button>
                    <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-30" disabled={index === config.contacts.length - 1}
                      aria-label={t("dashboard:handoff.moveDown")} onClick={() => move(index, 1)}>↓</button>
                    <button type="button" className="rounded border border-red-300 px-2 py-1 text-xs text-red-600"
                      aria-label={t("dashboard:handoff.remove")} onClick={() => patch({ contacts: config.contacts.filter((_, i) => i !== index) })}>×</button>
                  </div>
                </div>
              ))}
            </div>
            {config.contacts.length < LIMITS.contactsMax && (
              <button type="button" className={`${buttonClass} mt-2`}
                onClick={() => patch({ contacts: [...config.contacts, { id: `c${Date.now().toString(36)}`, role: "", name: "", phone: "" }] })}>
                {t("dashboard:handoff.add")}
              </button>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={config.whenCallerAsks} onChange={(e) => patch({ whenCallerAsks: e.target.checked })} />
            <span>{t("dashboard:handoff.whenCallerAsks")}</span>
          </label>

          <div className="flex flex-wrap gap-3">
            <div className="min-w-48 flex-1">
              <label className={labelClass} htmlFor="handoff-misses">{t("dashboard:handoff.afterMisses.label")}</label>
              <select id="handoff-misses" className={inputClass} value={config.afterMisses ?? DEFAULT_AFTER_MISSES}
                onChange={(e) => patch({ afterMisses: Number(e.target.value) })}>
                {Array.from({ length: LIMITS.missesMax - LIMITS.missesMin + 1 }, (_, i) => LIMITS.missesMin + i).map((n) => (
                  <option key={n} value={n}>{t("dashboard:handoff.afterMisses.option", { count: n })}</option>
                ))}
              </select>
              <p className={helpClass}>{t("dashboard:handoff.afterMisses.help")}</p>
            </div>
            <div className="min-w-48 flex-1">
              <label className={labelClass} htmlFor="handoff-hours">{t("dashboard:handoff.outsideHours.label")}</label>
              <select id="handoff-hours" className={inputClass} value={config.outsideHours}
                onChange={(e) => patch({ outsideHours: e.target.value })}>
                <option value="callback">{t("dashboard:handoff.outsideHours.callback")}</option>
                <option value="forward">{t("dashboard:handoff.outsideHours.forward")}</option>
              </select>
              <p className={helpClass}>{t("dashboard:handoff.outsideHours.help")}</p>
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor="handoff-topics">{t("dashboard:handoff.topics.label")}</label>
            <input id="handoff-topics" className={inputClass} value={topicsText} placeholder={t("dashboard:handoff.topics.placeholder")}
              onChange={(e) => {
                setTopicsText(e.target.value);
                patch({ topics: e.target.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean) });
              }} />
            <p className={helpClass}>{t("dashboard:handoff.topics.help")}</p>
          </div>
        </>
      )}
    </div>
  );
}
