"use client";

import { GREETING_LANGUAGES, MAX_GREETING_CHARS, BUSINESS_PLACEHOLDER, buildGreeting, greetingNotices } from "@/lib/voice/greeting";

/**
 * THE CALL GREETING — the Agent tab's "what the agent says when it picks up" (CLAUDE.md §6.24).
 *
 * Per agent: a call-recording switch and the owner's own greeting per spoken language. Empty = the
 * built-in greeting (AI notice; recording notice only while recording is on), shown as the
 * placeholder and in the preview. An owner-written greeting is spoken exactly as written; what it
 * leaves out is WARNED about here (lib/voice/greeting.js greetingNotices), never changed — the
 * owner decides.
 *
 * The preview uses the same function the call does, so what is shown is what is said.
 *
 * @param {object} props
 * @param {object} props.config        the agent being edited (businessName, replyLanguage, voices, greeting, recordCalls)
 * @param {(patch: {greeting?: object, recordCalls?: boolean}) => void} props.onChange
 * @param {(key: string, options?: object) => string} props.t
 */
export function GreetingPanel({ config, onChange, t, labelClass, helpClass, inputClass }) {
  const greeting = config.greeting ?? {};
  const recordCalls = Boolean(config.recordCalls);
  const named = config.businessName && config.businessName !== "this business" ? config.businessName : null;
  // The reply language first: that is the greeting callers hear today.
  const languages = [config.replyLanguage, ...GREETING_LANGUAGES.filter((l) => l !== config.replyLanguage)];

  const setText = (language, text) => onChange({ greeting: { ...greeting, [language]: text } });

  return (
    <fieldset className="flex flex-col gap-3 rounded border border-gray-200 p-3" data-testid="greeting-panel">
      <legend className="px-1 text-sm font-medium">{t("dashboard:greeting.title")}</legend>
      <p className={helpClass}>{t("dashboard:greeting.help", { vars: { placeholder: BUSINESS_PLACEHOLDER } })}</p>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={recordCalls} onChange={(e) => onChange({ recordCalls: e.target.checked })} />
        <span>
          <span className="font-medium">{t("dashboard:greeting.recordCalls")}</span>
          <span className={`block ${helpClass}`}>{t("dashboard:greeting.recordCallsHelp")}</span>
        </span>
      </label>

      {languages.map((language) => {
        const own = greeting[language] ?? "";
        const spoken = buildGreeting({ ...config, replyLanguage: language, greeting: { [language]: own } }, { businessName: named });
        const builtIn = buildGreeting({ ...config, replyLanguage: language, greeting: {} }, { businessName: named }).text;
        const notices = greetingNotices({ text: own, recordCalls });
        const rtl = language === "ur";
        return (
          <div key={language} className="flex flex-col gap-1">
            <label className={labelClass} htmlFor={`greeting-${language}`}>
              {t(`dashboard:greeting.label.${language}`)}
              {language === config.replyLanguage ? ` · ${t("dashboard:greeting.inUse")}` : ""}
            </label>
            <textarea
              id={`greeting-${language}`}
              className={`${inputClass} min-h-16`}
              dir={rtl ? "rtl" : "ltr"}
              maxLength={MAX_GREETING_CHARS}
              placeholder={builtIn}
              value={own}
              onChange={(e) => setText(language, e.target.value)}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
              <span>{own.trim() ? t("dashboard:greeting.ownText") : t("dashboard:greeting.builtIn")}</span>
              <span>
                {own.length}/{MAX_GREETING_CHARS}
                {own.trim() && (
                  <button type="button" className="ms-2 underline" onClick={() => setText(language, "")}>
                    {t("dashboard:greeting.useBuiltIn")}
                  </button>
                )}
              </span>
            </div>
            <p className="rounded bg-gray-50 px-2 py-1 text-sm" dir={rtl ? "rtl" : "ltr"} data-testid={`greeting-preview-${language}`}>
              <span className="text-xs text-gray-500">{t("dashboard:greeting.preview")} </span>
              {spoken.text}
            </p>
            {notices.map((notice) => (
              <p key={notice} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800" data-testid={`greeting-notice-${notice}`}>
                {t(`dashboard:greeting.notice.${notice}`)}
              </p>
            ))}
          </div>
        );
      })}
    </fieldset>
  );
}
