"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { translator, dirFor, isRTL, SUPPORTED_LOCALES } from "@/lib/i18n";

// Manual test harness for the API routes — NOT the real widget UI.
// Its only job is letting you prove the pipeline works end to end without
// curl/Postman. Delete it once a real widget frontend exists (Phase 2).
//
// NOTE ON THE CONFIG PANEL: /api/agent-config is a server-to-server endpoint
// guarded by INTERNAL_API_KEY, and this page is a browser client, so the panel
// only works while that variable is UNSET — i.e. on a dev machine. That's
// deliberate: sending the internal secret to the browser to make a throwaway
// harness more convenient would defeat the point of having the guard. In
// production the partner's dashboard backend calls that endpoint, not a browser.

const DEFAULT_TENANT_ID = "test-tenant";
const LOCALES = SUPPORTED_LOCALES;
const TONES = ["professional", "friendly", "concise", "formal"];

// Reads a fetch Response safely — the API routes should always return JSON, but
// if the dev server hard-crashes (or a proxy/timeout steps in) the body can come
// back empty or as an HTML error page. Parsing text first means the UI shows
// *something* instead of throwing "Unexpected end of JSON input" with no clue.
async function readJsonSafe(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      raw
        ? `Server returned non-JSON (status ${res.status}): ${raw.slice(0, 200)}`
        : `Server returned an empty response (status ${res.status}) — check the terminal running "npm run dev"`
    );
  }
}

export default function Home() {
  const [tenantId, setTenantId] = useState(DEFAULT_TENANT_ID);

  // --- agent config state ---
  const [config, setConfig] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [configStatus, setConfigStatus] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);

  // --- ingest panel state ---
  const [source, setSource] = useState("faq.txt");
  const [docText, setDocText] = useState("");
  const [ingestStatus, setIngestStatus] = useState(null);
  const [ingesting, setIngesting] = useState(false);

  // --- widget key state ---
  // The chat panel now goes through the real public auth path: a widget key
  // resolves to the tenant server-side. Kept in localStorage so a reload doesn't
  // mean provisioning another one.
  const [publicKey, setPublicKey] = useState("");
  const [keyStatus, setKeyStatus] = useState(null);
  const [creatingKey, setCreatingKey] = useState(false);

  // --- chat panel state ---
  const [conversationId, setConversationId] = useState(null);
  const [conversationToken, setConversationToken] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [locale, setLocale] = useState("en");
  const [sending, setSending] = useState(false);

  // The chat panel below renders through the SAME translator the widget will
  // use, so switching the locale dropdown is a real preview of what an Italian
  // or Arabic customer sees — including direction — not a mock-up.
  const tr = useMemo(() => translator(locale), [locale]);

  const loadConfig = useCallback(async () => {
    setConfigStatus(null);
    try {
      const [configRes, catalogRes] = await Promise.all([
        fetch(`/api/agent-config?tenantId=${encodeURIComponent(tenantId)}`),
        fetch("/api/agent-config/catalog"),
      ]);
      const configData = await readJsonSafe(configRes);
      if (!configRes.ok) throw new Error(configData.error || "Failed to load config");
      const catalogData = await readJsonSafe(catalogRes);
      if (!catalogRes.ok) throw new Error(catalogData.error || "Failed to load catalog");

      setConfig(configData.config);
      setCatalog(catalogData.capabilities);
      setLocale(configData.config.defaultLocale);
      setConfigStatus(
        configData.config.exists ? "Loaded." : "No config saved yet — showing defaults."
      );
    } catch (err) {
      setConfigStatus(`Error: ${err.message}`);
    }
  }, [tenantId]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Restore this tenant's key from a previous session.
  useEffect(() => {
    try {
      setPublicKey(window.localStorage.getItem(`widgetKey:${tenantId}`) ?? "");
    } catch {
      // Private browsing / storage disabled — the field just starts empty.
    }
    // Keys are tenant-scoped, so switching tenant must drop the conversation too.
    setConversationId(null);
    setConversationToken(null);
    setMessages([]);
  }, [tenantId]);

  function rememberKey(key) {
    setPublicKey(key);
    try {
      window.localStorage.setItem(`widgetKey:${tenantId}`, key);
    } catch {
      // Non-fatal: the key still works for this page load.
    }
  }

  async function createKey() {
    setCreatingKey(true);
    setKeyStatus(null);
    try {
      const res = await fetch(`/api/widget-keys?tenantId=${encodeURIComponent(tenantId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Empty allowlist = same-origin only, which is exactly what this
        // harness needs. A real tenant adds its site's origin here.
        body: JSON.stringify({ allowedOrigins: [], label: "Test harness" }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Could not create key");

      rememberKey(data.key.publicKey);
      setKeyStatus("Key created — same-origin only.");
    } catch (err) {
      setKeyStatus(`Error: ${err.message}`);
    } finally {
      setCreatingKey(false);
    }
  }

  async function saveConfig(e) {
    e.preventDefault();
    setSavingConfig(true);
    setConfigStatus(null);
    try {
      const res = await fetch(`/api/agent-config?tenantId=${encodeURIComponent(tenantId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: config.businessName,
          purpose: config.purpose,
          tone: config.tone,
          languages: config.languages,
          defaultLocale: config.defaultLocale,
          capabilities: config.capabilities,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) {
        throw new Error(
          data.details ? `${data.error}: ${data.details.join("; ")}` : data.error || "Save failed"
        );
      }
      setConfig(data.config);
      setConfigStatus("Saved. New messages will use it immediately.");
    } catch (err) {
      setConfigStatus(`Error: ${err.message}`);
    } finally {
      setSavingConfig(false);
    }
  }

  function patchConfig(patch) {
    setConfig((prev) => ({ ...prev, ...patch }));
  }

  function toggleCapability(id, enabled) {
    setConfig((prev) => ({
      ...prev,
      capabilities: {
        ...prev.capabilities,
        [id]: { ...(prev.capabilities?.[id] ?? {}), enabled },
      },
    }));
  }

  function toggleLanguage(code, on) {
    setConfig((prev) => {
      const languages = on
        ? [...new Set([...prev.languages, code])]
        : prev.languages.filter((l) => l !== code);
      const safe = languages.length ? languages : ["en"];
      return {
        ...prev,
        languages: safe,
        // Keep the two in step — the API rejects a defaultLocale that isn't enabled.
        defaultLocale: safe.includes(prev.defaultLocale) ? prev.defaultLocale : safe[0],
      };
    });
  }

  async function handleIngest(e) {
    e.preventDefault();
    setIngesting(true);
    setIngestStatus(null);
    try {
      const res = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, source, text: docText }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Ingest failed");
      setIngestStatus(`Inserted ${data.chunksInserted} chunk(s).`);
    } catch (err) {
      setIngestStatus(`Error: ${err.message}`);
    } finally {
      setIngesting(false);
    }
  }

  async function handleSend(e) {
    e.preventDefault();
    if (!input.trim()) return;

    if (!publicKey) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error: create a widget key first." },
      ]);
      return;
    }

    const userMessage = input;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setSending(true);

    try {
      // `?key=` in the URL as well as the body: a CORS preflight carries no
      // body, so the OPTIONS handler reads the key from the query string.
      const res = await fetch(`/api/widget?key=${encodeURIComponent(publicKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey,
          conversationId,
          conversationToken,
          message: userMessage,
          locale,
        }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Widget call failed");

      setConversationId(data.conversationId);
      setConversationToken(data.conversationToken);
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err.message}` },
      ]);
    } finally {
      setSending(false);
    }
  }

  function resetConversation() {
    setConversationId(null);
    setConversationToken(null);
    setMessages([]);
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">AI engine test harness</h1>
        <p className="text-sm text-gray-500">
          Manual test UI for /api/agent-config, /api/ingest and /api/widget — not the real widget.
        </p>
      </header>

      <div>
        <label className="mb-1 block text-sm font-medium">Tenant ID</label>
        <input
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
        />
        <p className="mt-1 text-xs text-gray-500">
          Any string works — tenant_id isn&apos;t FK-enforced yet. Keep it the same across
          config, ingest and chat.
        </p>
      </div>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="mb-3 font-medium">1. Agent configuration</h2>

        {!config ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <form onSubmit={saveConfig} className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium">Business name</label>
              <input
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                value={config.businessName}
                onChange={(e) => patchConfig({ businessName: e.target.value })}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium">
                Purpose — what the agent is here to do
              </label>
              <textarea
                className="min-h-20 w-full rounded border border-gray-300 px-3 py-2 text-sm"
                placeholder="e.g. Help customers book dental appointments and answer questions about our services."
                value={config.purpose}
                onChange={(e) => patchConfig({ purpose: e.target.value })}
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium">Tone</label>
                <select
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  value={config.tone}
                  onChange={(e) => patchConfig({ tone: e.target.value })}
                >
                  {TONES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium">Default language</label>
                <select
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
                  value={config.defaultLocale}
                  onChange={(e) => patchConfig({ defaultLocale: e.target.value })}
                >
                  {config.languages.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium">Enabled languages</label>
              <div className="flex gap-4">
                {LOCALES.map((code) => (
                  <label key={code} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={config.languages.includes(code)}
                      onChange={(e) => toggleLanguage(code, e.target.checked)}
                    />
                    {code}
                    {isRTL(code) && <span className="text-xs text-gray-400">(rtl)</span>}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium">
                What the agent can do
              </label>
              <div className="flex flex-col gap-2">
                {catalog.map((cap) => (
                  <label key={cap.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={Boolean(config.capabilities?.[cap.id]?.enabled)}
                      onChange={(e) => toggleCapability(cap.id, e.target.checked)}
                    />
                    <span>
                      {cap.label}
                      {cap.requiresTool && (
                        <span className="ml-1 text-xs text-amber-600">
                          (collects details only until Phase 4)
                        </span>
                      )}
                      <span className="block text-xs text-gray-500">{cap.description}</span>
                      <span className="block text-xs text-gray-400">
                        channels: {cap.channels.join(", ")}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={savingConfig}
                className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
              >
                {savingConfig ? "Saving…" : "Save configuration"}
              </button>
              <button
                type="button"
                onClick={loadConfig}
                className="rounded border border-gray-300 px-4 py-2 text-sm"
              >
                Reload
              </button>
              {configStatus && <p className="text-sm">{configStatus}</p>}
            </div>
          </form>
        )}
      </section>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="mb-3 font-medium">2. Widget key</h2>
        <p className="mb-3 text-xs text-gray-500">
          The chat below authenticates the way a real embedded widget does: a public key
          resolves to the tenant server-side. <code>tenantId</code> is never accepted from the
          request body.
        </p>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-gray-300 px-3 py-2 font-mono text-xs"
            placeholder="pk_…"
            value={publicKey}
            onChange={(e) => rememberKey(e.target.value)}
          />
          <button
            type="button"
            onClick={createKey}
            disabled={creatingKey}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {creatingKey ? "Creating…" : "Create key"}
          </button>
        </div>
        {keyStatus && <p className="mt-2 text-sm">{keyStatus}</p>}
      </section>

      <section className="rounded border border-gray-200 p-4">
        <h2 className="mb-3 font-medium">3. Add a document (ingest)</h2>
        <form onSubmit={handleIngest} className="flex flex-col gap-3">
          <input
            className="rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="source (e.g. faq.txt)"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
          <textarea
            className="min-h-32 rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder="Paste some FAQ / policy text to ingest..."
            value={docText}
            onChange={(e) => setDocText(e.target.value)}
          />
          <button
            type="submit"
            disabled={ingesting || !docText.trim()}
            className="self-start rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {ingesting ? "Ingesting..." : "Ingest document"}
          </button>
          {ingestStatus && <p className="text-sm">{ingestStatus}</p>}
        </form>
      </section>

      <section className="flex flex-1 flex-col rounded border border-gray-200 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">4. Chat (widget channel)</h2>
          <div className="flex items-center gap-2">
            <select
              className="rounded border border-gray-300 px-2 py-1 text-sm"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              {(config?.languages ?? LOCALES).map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={resetConversation}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              New conversation
            </button>
          </div>
        </div>

        <div
          className="mb-3 flex min-h-48 flex-1 flex-col gap-2 overflow-y-auto"
          dir={dirFor(locale)}
        >
          {messages.length === 0 && (
            <p className="text-sm text-gray-400">
              {tr("widget:greeting.default")}
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "self-end rounded bg-black px-3 py-2 text-sm text-white"
                  : "self-start rounded bg-gray-100 px-3 py-2 text-sm text-black"
              }
            >
              {m.content}
            </div>
          ))}
        </div>

        <form onSubmit={handleSend} className="flex gap-2" dir={dirFor(locale)}>
          <input
            className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
            placeholder={tr("widget:input.placeholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            type="submit"
            disabled={sending}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {sending ? tr("widget:status.typing") : tr("widget:input.send")}
          </button>
        </form>

        <p className="mt-2 text-xs text-gray-400" dir={dirFor(locale)}>
          {tr("widget:disclaimer.ai")}
        </p>

        {conversationId && (
          <p className="mt-2 text-xs text-gray-400">conversationId: {conversationId}</p>
        )}
      </section>
    </div>
  );
}
