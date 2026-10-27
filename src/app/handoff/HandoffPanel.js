"use client";

import { useState } from "react";
import { LIMITS, DEFAULT_AFTER_MISSES, emptyHandoffConfig } from "@/lib/handoff/config";
import { ANNOUNCE_LANGUAGES, ANNOUNCE_MAX_CHARS, ANNOUNCE_PLACEHOLDERS, announcementFor, nextContactLine } from "@/lib/handoff/announce";

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
 * The line said before every transfer ("I'm connecting you to Ali, our Representative…") is the
 * code's, not the model's (lib/handoff/announce.js). The owner may write their own per language;
 * the preview under it uses the same functions the call does, so what is shown is what is said.
 *
 * @param {object} props
 * @param {object} props.value       config.escalation
 * @param {"en"|"ur"} props.replyLanguage  the language the agent speaks (its line is listed first)
 * @param {(next: object) => void} props.onChange
 * @param {(key: string, options?: object) => string} props.t
 * @param {string} props.labelClass @param {string} props.helpClass @param {string} props.inputClass @param {string} props.buttonClass
 */
export function HandoffPanel({ value, replyLanguage = "en", onChange, t, labelClass, helpClass, inputClass, buttonClass }) {
  const config = { ...emptyHandoffConfig(), ...(value ?? {}) };
  const announce = config.announce ?? {};
  const setAnnounce = (language, text) => patch({ announce: { ...announce, [language]: text } });
  // The reply language first: that is the line callers hear today.
  const announceLanguages = [replyLanguage, ...ANNOUNCE_LANGUAGES.filter((l) => l !== replyLanguage)];
  // Rows the owner has started filling in; an empty row is dropped on save.
  const people = config.contacts.filter((c) => c.role?.trim() || c.name?.trim());
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

          <fieldset className="flex flex-col gap-3 rounded border border-gray-200 p-3" data-testid="handoff-announce">
            <legend className="px-1 text-sm font-medium">{t("dashboard:handoff.announce.title")}</legend>
            <p className={helpClass}>{t("dashboard:handoff.announce.help", { vars: { placeholders: ANNOUNCE_PLACEHOLDERS.join(" ") } })}</p>
            {announceLanguages.map((language) => {
              const own = announce[language] ?? "";
              const rtl = language === "ur";
              const escalation = { announce: { [language]: own } };
              const builtIn = announcementFor({ escalation: null, contact: { name: "{name}", role: "{role}" }, language });
              return (
                <div key={language} className="flex flex-col gap-1">
                  <label className={labelClass} htmlFor={`handoff-announce-${language}`}>
                    {t(`dashboard:handoff.announce.label.${language}`)}
                    {language === replyLanguage ? ` · ${t("dashboard:handoff.announce.inUse")}` : ""}
                  </label>
                  <input id={`handoff-announce-${language}`} className={inputClass} dir={rtl ? "rtl" : "ltr"} maxLength={ANNOUNCE_MAX_CHARS}
                    placeholder={builtIn} value={own} onChange={(e) => setAnnounce(language, e.target.value)} />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                    <span>{own.trim() ? t("dashboard:handoff.announce.ownText") : t("dashboard:handoff.announce.builtIn")}</span>
                    <span>
                      {own.length}/{ANNOUNCE_MAX_CHARS}
                      {own.trim() && (
                        <button type="button" className="ms-2 underline" onClick={() => setAnnounce(language, "")}>
                          {t("dashboard:handoff.announce.useBuiltIn")}
                        </button>
                      )}
                    </span>
                  </div>
                  {people.length === 0 ? (
                    <p className="text-xs text-gray-500">{t("dashboard:handoff.announce.noContacts")}</p>
                  ) : (
                    <ul className="flex flex-col gap-1" data-testid={`handoff-announce-preview-${language}`}>
                      {people.map((contact, index) => (
                        <li key={contact.id || index} className="rounded bg-gray-50 px-2 py-1 text-sm" dir={rtl ? "rtl" : "ltr"}>
                          <span className="block text-xs text-gray-500">
                            {index === 0
                              ? t("dashboard:handoff.announce.preview", { vars: { who: contact.name || contact.role } })
                              : t("dashboard:handoff.announce.nextPreview", { vars: { previous: people[index - 1].name || people[index - 1].role } })}
                          </span>
                          {index === 0
                            ? announcementFor({ escalation, contact, language })
                            : nextContactLine({ escalation, previous: people[index - 1], contact, language })}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </fieldset>
        </>
      )}
    </div>
  );
}
