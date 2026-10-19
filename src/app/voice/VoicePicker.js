"use client";

import { useEffect, useRef, useState } from "react";
import { VOICES, SPOKEN_LANGUAGES, voiceFor } from "@/lib/voice/speech/voices";

/**
 * THE AGENT'S VOICE — one choice per language the agent can speak on a call.
 *
 * Only real voices: the list is the catalog in lib/voice/speech/voices.js, i.e. the
 * speakers inside the models the gateway actually has. Voices whose model is not
 * downloaded on this gateway are shown but disabled (learned from its /health), so a
 * business never picks something that would silently fall back to the default.
 *
 * ▶ plays the voice saying a fixed sample line, rendered by the gateway (cached there per
 * voice). Only the reply language is shown: the agent speaks only the language the
 * business chose, although it understands both.
 *
 * The value is agent_configs.voices ({ [language]: voiceId }); saving is the form's
 * normal Save, validated server-side (PUT /api/agent-config).
 */
export function VoicePicker({ voices, replyLanguage, onChange, t, labelClass, helpClass, inputClass }) {
  const [gateway, setGateway] = useState(null); // { previewUrl, installed: Set|null }
  const [playing, setPlaying] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const audio = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let retry = null;
    (async () => {
      let info;
      try {
        info = await (await fetch("/api/voice/gateway")).json();
      } catch {
        if (!cancelled) setGateway({ previewUrl: null, installed: null, urduStt: null });
        return;
      }
      // The gateway answers "loading" for the few seconds it takes to load its models
      // (right after a restart, exactly when someone opens this page) — keep asking
      // until it is ready, instead of concluding from that first answer.
      const check = async (attempt) => {
        let installed = null;
        let urduStt = null;
        let loading = false;
        try {
          const health = await (await fetch(info.healthUrl, { cache: "no-store" })).json();
          loading = health.status === "loading";
          if (Array.isArray(health.installedVoices) && health.installedVoices.length) installed = new Set(health.installedVoices);
          if (health.engine?.sttRouting) urduStt = Boolean(health.engine.sttRouting.hosted);
        } catch {
          // Gateway not running: every voice stays selectable, previews will say why they fail.
        }
        if (cancelled) return;
        setGateway({ previewUrl: info.previewUrl, installed, urduStt });
        if (loading && attempt < 30) retry = setTimeout(() => check(attempt + 1), 3000);
      };
      await check(0);
    })();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      audio.current?.pause();
    };
  }, []);

  const languages = SPOKEN_LANGUAGES.includes(replyLanguage) ? [replyLanguage] : ["en"];

  function preview(voiceId) {
    audio.current?.pause();
    setPreviewError(null);
    if (playing === voiceId) return setPlaying(null);
    if (!gateway?.previewUrl) return setPreviewError("offline");

    const player = new Audio(`${gateway.previewUrl}?voice=${encodeURIComponent(voiceId)}`);
    audio.current = player;
    setPlaying(voiceId);
    player.onended = () => setPlaying((p) => (p === voiceId ? null : p));
    player.onerror = () => {
      setPlaying(null);
      setPreviewError("failed");
    };
    player.play().catch(() => {
      setPlaying(null);
      setPreviewError("failed");
    });
  }

  return (
    <div>
      <span className={labelClass}>{t("dashboard:voice.picker.title")}</span>
      <p className={`${helpClass} mb-2`}>{t("dashboard:voice.picker.help")}</p>

      <div className="flex flex-col gap-2">
        {languages.map((language) => {
          const current = voiceFor(voices, language);
          const options = VOICES.filter((v) => v.language === language);
          return (
            <div key={language} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-sm">{t(`common:language.${language}`)}</span>
              <select
                aria-label={t("dashboard:voice.picker.forLanguage", { vars: { language: t(`common:language.${language}`) } })}
                className={`${inputClass} min-w-56 flex-1`}
                value={current.id}
                onChange={(e) => onChange({ ...voices, [language]: e.target.value })}
              >
                {["female", "male"].map((gender) => (
                  <optgroup key={gender} label={t(`dashboard:voice.picker.gender.${gender}`)}>
                    {options
                      .filter((v) => v.gender === gender)
                      .map((v) => {
                        const missing = gateway?.installed && !gateway.installed.has(v.id);
                        return (
                          <option key={v.id} value={v.id} disabled={missing}>
                            {`${v.name} · ${t(`dashboard:voice.picker.accent.${v.accent}`)} · ${t(`dashboard:voice.picker.tier.${v.tier}`)}`}
                            {missing ? ` (${t("dashboard:voice.picker.notInstalled")})` : ""}
                          </option>
                        );
                      })}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                onClick={() => preview(current.id)}
                className="rounded border border-gray-300 px-3 py-2 text-sm"
                aria-pressed={playing === current.id}
              >
                {playing === current.id ? t("dashboard:voice.picker.stop") : t("dashboard:voice.picker.preview")}
              </button>
            </div>
          );
        })}
      </div>

      <p className={helpClass}>{t("dashboard:voice.picker.tierHelp")}</p>
      {/* Every call may be spoken in Urdu, whichever language the agent answers in, and
          understanding Urdu needs the hosted recogniser (lib/voice/speech/stt.js). Said
          plainly here instead of being discovered on a call. */}
      {gateway?.urduStt === false && (
        <p className="mt-1 text-xs text-amber-700">{t("dashboard:voice.picker.urduSttMissing")}</p>
      )}
      {previewError && (
        <p className="mt-1 text-xs text-amber-700">{t(`dashboard:voice.picker.previewError.${previewError}`)}</p>
      )}
    </div>
  );
}
