"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FIELDS, FIELD_GROUPS, INDUSTRIES, LIMITS, RECORD_TYPES, CUSTOM_FIELD_TYPES, getField, getIndustry, pick } from "@/lib/collect/catalog";
import { choiceOptions, fieldDef, missingLists, presetConfig, typeFields, recordTypeLabel } from "@/lib/collect/config";
import { displayValue } from "@/lib/collect/validate";

/**
 * "WHAT YOUR AGENT COLLECTS" — the screen where a business decides which details its agent
 * asks a customer for, in which order, and for which kinds of request.
 *
 * Nothing on it is specific to one kind of business: the checklist is drawn from the
 * catalogue (lib/collect/catalog.js) and a business type is only a starting selection
 * (INDUSTRIES). The owner then ticks, orders and rewords; a detail the catalogue lacks is
 * added as a "custom detail". What is saved is one document (agent_configs.collect), and
 * the engine builds its questions from it on the next message.
 *
 * It edits a LOCAL copy and saves on request: a half-edited form (an appointment with no
 * phone number) must never reach a live agent, and the server refuses it anyway
 * (PUT /api/collect, lib/collect/config.js validateCollectConfig).
 */

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);

/** "Root canal | روٹ کینال" per line  ⇄  [{ id, label: { en, ur } }] */
function parseLines(text) {
  return String(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [first, ...rest] = line.split("|").map((part) => part.trim());
      const second = rest.join("|").trim();
      const urdu = /[؀-ۿ]/;
      // One name only: put it in the language it is written in.
      if (!second) return urdu.test(first) ? { label: { ur: first } } : { label: { en: first } };
      return urdu.test(first) && !urdu.test(second) ? { label: { en: second, ur: first } } : { label: { en: first, ur: second } };
    });
}
const linesOf = (list) => (list ?? []).map((item) => [item.label?.en, item.label?.ur].filter(Boolean).join(" | ")).join("\n");

/** Keep an existing entry's id when its text still matches, so renaming one does not orphan the rest. */
function withIds(parsed, previous) {
  return parsed.map((item) => {
    const same = previous.find((p) => p.label?.en === item.label.en && p.label?.ur === item.label.ur);
    return same ? { ...item, id: same.id } : item;
  });
}

export function CollectPanel({ tenantId, agentId, uiLocale, replyLanguage, t, cardClass, labelClass, helpClass, inputClass, buttonClass }) {
  const [config, setConfig] = useState(null);
  const [version, setVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [problems, setProblems] = useState([]);
  const [industry, setIndustry] = useState("");
  const [servicesText, setServicesText] = useState("");
  const [staffText, setStaffText] = useState("");
  const [menuText, setMenuText] = useState("");
  const [custom, setCustom] = useState({ labelEn: "", labelUr: "", type: "text", options: "", sensitive: false });
  const [openWording, setOpenWording] = useState(null);
  const [addPick, setAddPick] = useState({});

  // Each agent has its own checklist (CLAUDE.md §6.27); null = the default agent.
  const query = `tenantId=${encodeURIComponent(tenantId)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}&locale=${uiLocale}`;

  // `load` is the Reload button; the effect below runs the same fetch without a synchronous
  // setState in its body (react-hooks/set-state-in-effect): state is only set after the await.
  const apply = useCallback((data) => {
    setConfig(data.collect);
    setVersion(data.version);
    setIndustry(data.collect.industry ?? "");
    setServicesText(linesOf(data.collect.services));
    setStaffText(linesOf(data.collect.staff));
    setMenuText(linesOf(data.collect.menu));
    setDirty(false);
    setProblems([]);
    setStatus(null);
  }, []);

  const fetchCollect = useCallback(async () => {
    const res = await fetch(`/api/collect?${query}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed");
    return data;
  }, [query]);

  const load = useCallback(async () => {
    try {
      apply(await fetchCollect());
    } catch (err) {
      setStatus(String(err.message || err));
    }
  }, [apply, fetchCollect]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchCollect();
        if (!cancelled) apply(data);
      } catch (err) {
        if (!cancelled) setStatus(String(err.message || err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply, fetchCollect]);

  const edit = (change) => {
    setConfig((prev) => change(structuredClone(prev)));
    setDirty(true);
    setStatus(null);
  };

  const language = replyLanguage === "ur" ? "ur" : "en";

  async function save() {
    setSaving(true);
    setProblems([]);
    setStatus(null);
    try {
      const res = await fetch(`/api/collect?${query}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collect: config }),
      });
      const data = await res.json();
      if (!res.ok) {
        setProblems(data.details ?? [data.error]);
        return;
      }
      setConfig(data.collect);
      setVersion(data.version);
      setServicesText(linesOf(data.collect.services));
      setStaffText(linesOf(data.collect.staff));
      setMenuText(linesOf(data.collect.menu));
      setDirty(false);
      setStatus(t("dashboard:collect.saved"));
    } catch (err) {
      setProblems([String(err.message || err)]);
    } finally {
      setSaving(false);
    }
  }

  function applyIndustry() {
    if (!industry) return;
    const preset = getIndustry(industry);
    const name = pick(preset.label, uiLocale);
    if (!window.confirm(t("dashboard:collect.industry.confirm", { vars: { industry: name } }))) return;
    edit((c) => ({ ...c, industry, recordTypes: presetConfig(industry).recordTypes }));
  }

  function addSuggestions() {
    const preset = getIndustry(industry || config.industry);
    if (!preset?.suggestedServices?.length) return;
    const merged = [...parseLines(servicesText), ...preset.suggestedServices.map((s) => ({ label: s }))];
    const seen = new Set();
    const unique = merged.filter((item) => {
      const key = item.label.en || item.label.ur;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const text = linesOf(unique);
    setServicesText(text);
    edit((c) => ({ ...c, services: withIds(unique, c.services) }));
  }

  const usesField = (id) => RECORD_TYPES.some((type) => config?.recordTypes?.[type.id]?.fields.some((f) => f.id === id));

  function addCustomField() {
    const label = { ...(custom.labelEn.trim() ? { en: custom.labelEn.trim() } : {}), ...(custom.labelUr.trim() ? { ur: custom.labelUr.trim() } : {}) };
    if (!label.en && !label.ur) return;
    const base = `c_${slug(label.en || "detail") || "detail"}`;
    edit((c) => {
      let id = base;
      for (let n = 2; c.customFields.some((f) => f.id === id) || getField(id); n++) id = `${base}_${n}`;
      const field = { id, type: custom.type, label, question: {}, sensitive: custom.sensitive };
      if (custom.type === "choice") field.options = parseLines(custom.options);
      c.customFields.push(field);
      return c;
    });
    setCustom({ labelEn: "", labelUr: "", type: "text", options: "", sensitive: false });
  }

  const available = useMemo(() => {
    if (!config) return [];
    return [...FIELDS, ...config.customFields.map((f) => fieldDef(config, f.id))];
  }, [config]);

  if (!config) {
    return (
      <section className={cardClass}>
        <h2 className="mb-1 font-medium">{t("dashboard:collect.title")}</h2>
        <p className="text-sm text-gray-400">{status || t("common:state.loading")}</p>
      </section>
    );
  }

  const groupLabel = (g) => t(`dashboard:collect.group.${g}`);
  // Types switched on that cannot be taken yet (orders with no menu): said, not refused.
  const missing = new Set(missingLists(config).map((m) => m.type));
  /** "only when “Pickup or delivery” is Delivery" for a field asked after a particular answer. */
  const conditionText = (when) => {
    const source = fieldDef(config, when?.field);
    if (!source) return null;
    const option = source.type === "yesno" ? { label: { en: when.equals === "yes" ? "Yes" : "No", ur: when.equals === "yes" ? "ہاں" : "نہیں" } } : choiceOptions(config, source).find((o) => o.id === when.equals);
    return t("dashboard:collect.fields.when", { vars: { field: pick(source.label, uiLocale), value: option ? pick(option.label, uiLocale) : when.equals } });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className={`${cardClass} flex flex-col gap-4`}>
        <div>
          <h2 className="mb-1 font-medium">{t("dashboard:collect.title")}</h2>
          <p className={helpClass}>{t("dashboard:collect.help")}</p>
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={config.enabled} onChange={(e) => edit((c) => ({ ...c, enabled: e.target.checked }))} />
          <span>
            {t("dashboard:collect.enable")}
            <span className="block text-xs text-gray-500">{t("dashboard:collect.enableHelp")}</span>
          </span>
        </label>

        <div>
          <label className={labelClass} htmlFor="industry">{t("dashboard:collect.industry.label")}</label>
          <div className="flex flex-wrap gap-2">
            <select id="industry" className={`${inputClass} min-w-56 flex-1`} value={industry} onChange={(e) => setIndustry(e.target.value)}>
              <option value="">{t("dashboard:collect.industry.choose")}</option>
              {INDUSTRIES.map((i) => (
                <option key={i.id} value={i.id}>{pick(i.label, uiLocale)}</option>
              ))}
            </select>
            <button type="button" onClick={applyIndustry} disabled={!industry} className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40">
              {t("dashboard:collect.industry.apply")}
            </button>
          </div>
          <p className={helpClass}>{t("dashboard:collect.industry.help")}</p>
        </div>

        {RECORD_TYPES.map((type) => {
          const entry = config.recordTypes[type.id];
          const selectedIds = new Set(entry.fields.map((f) => f.id));
          const remaining = available.filter((f) => !selectedIds.has(f.id));
          const typeLabel = recordTypeLabel(config, type.id, uiLocale);
          const count = entry.fields.length;
          const questions = typeFields(config, type.id);

          const update = (change) =>
            edit((c) => {
              change(c.recordTypes[type.id]);
              return c;
            });
          const move = (index, delta) =>
            update((e) => {
              const target = index + delta;
              if (target < 0 || target >= e.fields.length) return;
              [e.fields[index], e.fields[target]] = [e.fields[target], e.fields[index]];
            });

          return (
            <div key={type.id} className="rounded border border-gray-200 p-3">
              <label className="flex items-start gap-2 text-sm font-medium">
                <input type="checkbox" className="mt-1" checked={entry.enabled} onChange={(e) => update((x) => (x.enabled = e.target.checked))} />
                <span>
                  {typeLabel}
                  <span className="block text-xs font-normal text-gray-500">{pick(type.description, uiLocale)}</span>
                </span>
              </label>

              {entry.enabled && missing.has(type.id) && (
                <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800" data-testid={`collect-missing-${type.id}`}>
                  {t("dashboard:collect.menu.missing")}
                </p>
              )}

              {entry.enabled && (
                <div className="mt-3 flex flex-col gap-3">
                  <div>
                    <span className={labelClass}>{t("dashboard:collect.fields.title")}</span>
                    {count === 0 && <p className={helpClass}>{t("dashboard:collect.fields.empty")}</p>}
                    <ol className="flex flex-col gap-2">
                      {entry.fields.map((item, index) => {
                        const def = fieldDef(config, item.id);
                        if (!def) return null;
                        const wording = openWording === `${type.id}:${item.id}`;
                        return (
                          <li key={item.id} className="rounded border border-gray-200 p-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="w-6 shrink-0 text-center text-xs text-gray-400">{index + 1}</span>
                              <span className="min-w-32 flex-1 text-sm">
                                {pick(def.label, uiLocale)}
                                {def.sensitivity === "sensitive" && (
                                  <span className="ms-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800" title={t("dashboard:collect.fields.sensitive")}>
                                    ⚠ {t("dashboard:collect.fields.sensitive")}
                                  </span>
                                )}
                                {item.when && conditionText(item.when) && <span className="ms-2 text-xs text-gray-500">({conditionText(item.when)})</span>}
                              </span>
                              <select
                                aria-label={t("dashboard:collect.fields.required")}
                                className="rounded border border-gray-300 px-2 py-1 text-sm"
                                value={item.required ? "required" : "optional"}
                                onChange={(e) => update((x) => (x.fields[index].required = e.target.value === "required"))}
                              >
                                <option value="required">{t("dashboard:collect.fields.required")}</option>
                                <option value="optional">{t("dashboard:collect.fields.optional")}</option>
                              </select>
                              <button type="button" aria-label={t("dashboard:collect.fields.up")} title={t("dashboard:collect.fields.up")} disabled={index === 0} onClick={() => move(index, -1)} className="rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-30">↑</button>
                              <button type="button" aria-label={t("dashboard:collect.fields.down")} title={t("dashboard:collect.fields.down")} disabled={index === count - 1} onClick={() => move(index, 1)} className="rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-30">↓</button>
                              <button type="button" onClick={() => setOpenWording(wording ? null : `${type.id}:${item.id}`)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                                {t("dashboard:collect.fields.wording")}
                              </button>
                              <button type="button" aria-label={t("dashboard:collect.fields.remove")} title={t("dashboard:collect.fields.remove")} onClick={() =>
                                  update((x) => {
                                    const [removed] = x.fields.splice(index, 1);
                                    // A question asked only after this answer is now always asked.
                                    for (const other of x.fields) if (other.when?.field === removed.id) delete other.when;
                                  })
                                } className="rounded border border-red-200 px-2 py-1 text-sm text-red-600">✕</button>
                            </div>
                            {wording && (
                              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                {["en", "ur"].map((lang) => (
                                  <div key={lang}>
                                    <label className="mb-1 block text-xs font-medium">{t(lang === "en" ? "dashboard:collect.fields.wordingEn" : "dashboard:collect.fields.wordingUr")}</label>
                                    <input
                                      className={inputClass}
                                      dir={lang === "ur" ? "rtl" : "ltr"}
                                      lang={lang}
                                      maxLength={LIMITS.questionMax}
                                      placeholder={def.question?.[lang] ?? ""}
                                      value={item.question?.[lang] ?? ""}
                                      onChange={(e) =>
                                        update((x) => {
                                          const q = { ...(x.fields[index].question ?? {}), [lang]: e.target.value };
                                          if (!q[lang]) delete q[lang];
                                          if (Object.keys(q).length) x.fields[index].question = q;
                                          else delete x.fields[index].question;
                                        })
                                      }
                                    />
                                  </div>
                                ))}
                                <p className={`${helpClass} sm:col-span-2`}>{t("dashboard:collect.fields.wordingHelp")}</p>
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ol>
                    <p className={`${helpClass} ${count > LIMITS.fieldsWarnAt ? "text-amber-700" : ""}`}>
                      {t("dashboard:collect.fields.count", { count })}
                      {count > LIMITS.fieldsWarnAt && ` — ${t("dashboard:collect.fields.tooMany", { vars: { max: LIMITS.fieldsWarnAt } })}`}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <select
                      aria-label={t("dashboard:collect.fields.addPick")}
                      className={`${inputClass} min-w-56 flex-1`}
                      value={addPick[type.id] ?? ""}
                      onChange={(e) => setAddPick((p) => ({ ...p, [type.id]: e.target.value }))}
                    >
                      <option value="">{t("dashboard:collect.fields.addPick")}</option>
                      {[...FIELD_GROUPS, "custom"].map((g) => {
                        const items = remaining.filter((f) => (g === "custom" ? f.custom : !f.custom && f.group === g));
                        if (!items.length) return null;
                        return (
                          <optgroup key={g} label={groupLabel(g)}>
                            {items.map((f) => (
                              <option key={f.id} value={f.id}>
                                {pick(f.label, uiLocale)}
                                {f.sensitivity === "sensitive" ? " ⚠" : ""}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                    <button
                      type="button"
                      disabled={!addPick[type.id]}
                      onClick={() => {
                        const id = addPick[type.id];
                        update((x) => x.fields.push({ id, required: false }));
                        setAddPick((p) => ({ ...p, [type.id]: "" }));
                      }}
                      className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40"
                    >
                      {t("dashboard:collect.fields.add")}
                    </button>
                  </div>

                  {questions.length > 0 && (
                    <div className="rounded bg-gray-50 p-3">
                      <span className={labelClass}>{t("dashboard:collect.preview.title")}</span>
                      <ol className="ms-5 list-decimal text-sm text-gray-700" dir={language === "ur" ? "rtl" : "ltr"} lang={language}>
                        {questions.map((q) => (
                          <li key={q.id}>
                            {q.question[language]}
                            {!q.required && <span className="ms-1 text-xs text-gray-400">({t("dashboard:collect.preview.optional")})</span>}
                            {q.when && conditionText(q.when) && <span className="ms-1 text-xs text-gray-400">({conditionText(q.when)})</span>}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {(usesField("service") || config.services.length > 0) && (
          <div>
            <label className={labelClass} htmlFor="services">{t("dashboard:collect.services.title")}</label>
            <textarea
              id="services"
              className={`${inputClass} min-h-24`}
              placeholder={t("dashboard:collect.services.placeholder")}
              value={servicesText}
              onChange={(e) => {
                setServicesText(e.target.value);
                edit((c) => ({ ...c, services: withIds(parseLines(e.target.value), c.services) }));
              }}
            />
            <p className={helpClass}>{t("dashboard:collect.services.help")}</p>
            {getIndustry(industry || config.industry)?.suggestedServices?.length > 0 && (
              <button type="button" onClick={addSuggestions} className="mt-1 rounded border border-gray-300 px-3 py-1 text-xs">
                {t("dashboard:collect.services.suggest")}
              </button>
            )}
          </div>
        )}

        {(usesField("order_items") || config.menu.length > 0) && (
          <div>
            <label className={labelClass} htmlFor="menu">{t("dashboard:collect.menu.title")}</label>
            <textarea
              id="menu"
              className={`${inputClass} min-h-28`}
              placeholder={t("dashboard:collect.menu.placeholder")}
              value={menuText}
              onChange={(e) => {
                setMenuText(e.target.value);
                edit((c) => ({ ...c, menu: withIds(parseLines(e.target.value), c.menu) }));
              }}
            />
            <p className={helpClass}>{t("dashboard:collect.menu.help")}</p>
          </div>
        )}

        {(usesField("staff") || config.staff.length > 0) && (
          <div>
            <label className={labelClass} htmlFor="staff">{t("dashboard:collect.staff.title")}</label>
            <textarea
              id="staff"
              className={`${inputClass} min-h-20`}
              placeholder={t("dashboard:collect.staff.placeholder")}
              value={staffText}
              onChange={(e) => {
                setStaffText(e.target.value);
                edit((c) => ({ ...c, staff: withIds(parseLines(e.target.value), c.staff) }));
              }}
            />
            <p className={helpClass}>{t("dashboard:collect.staff.help")}</p>
          </div>
        )}

        <div className="rounded border border-gray-200 p-3">
          <span className={labelClass}>{t("dashboard:collect.custom.title")}</span>
          <p className={`${helpClass} mb-2`}>{t("dashboard:collect.custom.help")}</p>
          {config.customFields.length > 0 && (
            <ul className="mb-3 flex flex-col gap-1 text-sm">
              {config.customFields.map((f) => (
                <li key={f.id} className="flex items-center gap-2">
                  <span className="flex-1">
                    {pick(f.label, uiLocale)} <span className="text-xs text-gray-400">· {t(`dashboard:collect.custom.type.${f.type}`)}</span>
                  </span>
                  <button
                    type="button"
                    aria-label={t("dashboard:collect.fields.remove")}
                    onClick={() =>
                      edit((c) => {
                        c.customFields = c.customFields.filter((x) => x.id !== f.id);
                        for (const type of RECORD_TYPES) c.recordTypes[type.id].fields = c.recordTypes[type.id].fields.filter((x) => x.id !== f.id);
                        return c;
                      })
                    }
                    className="rounded border border-red-200 px-2 py-1 text-sm text-red-600"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium">{t("dashboard:collect.custom.labelEn")}</label>
              <input className={inputClass} maxLength={LIMITS.labelMax} value={custom.labelEn} onChange={(e) => setCustom({ ...custom, labelEn: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">{t("dashboard:collect.custom.labelUr")}</label>
              <input className={inputClass} dir="rtl" lang="ur" maxLength={LIMITS.labelMax} value={custom.labelUr} onChange={(e) => setCustom({ ...custom, labelUr: e.target.value })} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">{t("dashboard:collect.custom.type")}</label>
              <select className={inputClass} value={custom.type} onChange={(e) => setCustom({ ...custom, type: e.target.value })}>
                {CUSTOM_FIELD_TYPES.map((type) => (
                  <option key={type} value={type}>{t(`dashboard:collect.custom.type.${type}`)}</option>
                ))}
              </select>
            </div>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={custom.sensitive} onChange={(e) => setCustom({ ...custom, sensitive: e.target.checked })} />
              {t("dashboard:collect.custom.sensitive")}
            </label>
            {custom.type === "choice" && (
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium">{t("dashboard:collect.custom.options")}</label>
                <textarea className={`${inputClass} min-h-20`} value={custom.options} onChange={(e) => setCustom({ ...custom, options: e.target.value })} />
              </div>
            )}
          </div>
          <button type="button" onClick={addCustomField} disabled={!custom.labelEn.trim() && !custom.labelUr.trim()} className="mt-2 rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40">
            {t("dashboard:collect.custom.add")}
          </button>
        </div>

        {problems.length > 0 && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            <p className="font-medium">{t("dashboard:collect.problems")}</p>
            <ul className="ms-5 list-disc">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={saving || !dirty} className={buttonClass}>
            {saving ? t("common:state.saving") : t("dashboard:collect.save")}
          </button>
          <button type="button" onClick={load} disabled={saving} className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40">
            {t("common:action.reload")}
          </button>
          <span className="text-xs text-gray-500">{t("dashboard:collect.version", { vars: { version } })}</span>
          {dirty && <span className="text-sm text-amber-700">{t("dashboard:collect.unsaved")}</span>}
          {status && !dirty && <span className="text-sm">{status}</span>}
        </div>
      </section>

      <RecordsPanel tenantId={tenantId} agentId={agentId} uiLocale={uiLocale} config={config} t={t} cardClass={cardClass} helpClass={helpClass} />
    </div>
  );
}

const STATUSES = ["requested", "confirmed", "done", "cancelled"];
/** Where a request may be moved (mirrors lib/standins/records.js TRANSITIONS). */
const NEXT = { requested: ["confirmed", "cancelled"], confirmed: ["done", "cancelled", "requested"], done: ["confirmed"], cancelled: ["requested"] };
const BADGE = { requested: "bg-amber-100 text-amber-800", confirmed: "bg-green-100 text-green-800", done: "bg-gray-200 text-gray-700", cancelled: "bg-red-100 text-red-700" };

/**
 * THE REQUESTS THE AGENT HAS TAKEN — what customers asked for, waiting for a person.
 * Polls while it is on screen so a request taken in the test chat or on a call shows up
 * without reloading. Backed by the stand-in records (src/lib/standins/); the backend owns
 * these in production.
 */
function RecordsPanel({ tenantId, agentId, uiLocale, config, t, cardClass, helpClass }) {
  const [filter, setFilter] = useState("requested");
  const [list, setList] = useState({ data: [], counts: {}, total: 0 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const fetchList = useCallback(async () => {
    // Only the requests THIS agent took.
    const res = await fetch(`/api/records?tenantId=${encodeURIComponent(tenantId)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}&locale=${uiLocale}${filter ? `&status=${filter}` : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "failed");
    return data;
  }, [tenantId, agentId, uiLocale, filter]);

  const load = useCallback(async () => {
    try {
      setList(await fetchList());
      setError(null);
    } catch (err) {
      setError(String(err.message || err));
    }
  }, [fetchList]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await fetchList();
        if (!cancelled) {
          setList(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(String(err.message || err));
      }
    };
    tick();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") tick();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchList]);

  async function move(record, status) {
    setBusy(record.id);
    try {
      const res = await fetch(`/api/records/${record.id}?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) setError(t("dashboard:records.updateFailed"));
      await load();
    } finally {
      setBusy(null);
    }
  }

  const ctx = { config, language: uiLocale };
  const when = (iso) => new Intl.DateTimeFormat(uiLocale === "ur" ? "ur-PK" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  return (
    <section className={cardClass}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">{t("dashboard:records.title")}</h2>
          <p className={helpClass}>{t("dashboard:records.help")}</p>
        </div>
        <button type="button" onClick={load} className="rounded border border-gray-300 px-3 py-1 text-sm">
          {t("dashboard:records.refresh")}
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-2" role="tablist">
        {["", ...STATUSES].map((s) => {
          const count = s ? list.counts?.[s] : STATUSES.reduce((sum, k) => sum + (list.counts?.[k] ?? 0), 0);
          return (
            <button
              key={s || "all"}
              type="button"
              role="tab"
              aria-selected={filter === s}
              onClick={() => setFilter(s)}
              className={`rounded-full border px-3 py-1 text-xs ${filter === s ? "border-black bg-black text-white" : "border-gray-300"}`}
            >
              {s ? t(`dashboard:records.status.${s}`) : t("dashboard:records.filter.all")} · {count ?? 0}
            </button>
          );
        })}
      </div>

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {list.data.length === 0 ? (
        <p className="text-sm text-gray-400">{t("dashboard:records.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.data.map((record) => {
            const fields = Object.entries(record.data ?? {})
              .map(([id, value]) => [fieldDef(config, id), value])
              .filter(([def]) => def)
              .map(([def, value]) => ({ id: def.id, label: pick(def.label, uiLocale), text: displayValue(def, value, ctx) }));
            const typeLabel = recordTypeLabel(config, record.type, uiLocale);
            return (
              <li key={record.id} className="rounded border border-gray-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{record.reference}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${BADGE[record.status]}`}>{t(`dashboard:records.status.${record.status}`)}</span>
                  <span className="text-xs text-gray-500">{typeLabel}</span>
                  <span className="text-xs text-gray-400">· {t(`dashboard:records.via.${record.channel === "voice" ? "voice" : "chat"}`)}</span>
                  <span className="ms-auto text-xs text-gray-400">{t("dashboard:records.received", { vars: { time: when(record.createdAt) } })}</span>
                </div>
                <p className="mt-1 text-sm">{record.summary}</p>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                  {fields.map((f) => (
                    <div key={f.id} className="flex gap-2">
                      <dt className="text-gray-500">{f.label}:</dt>
                      <dd dir="auto">{f.text}</dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {record.customer?.phone && (
                    <a href={`tel:${record.customer.phone}`} className="rounded border border-gray-300 px-3 py-1 text-sm">
                      {t("dashboard:records.call")}
                    </a>
                  )}
                  {(NEXT[record.status] ?? []).map((next) => (
                    <button
                      key={next}
                      type="button"
                      disabled={busy === record.id}
                      onClick={() => move(record, next)}
                      className={`rounded px-3 py-1 text-sm disabled:opacity-40 ${next === "confirmed" ? "bg-black text-white" : "border border-gray-300"}`}
                    >
                      {t(`dashboard:records.action.${next}`)}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

