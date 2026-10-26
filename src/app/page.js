"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { translator, dirFor, LOCALE_META, REPLY_LANGUAGES } from "@/lib/i18n";
import { VoiceCallPanel } from "./voice/VoiceCallPanel";
import { VoicePicker } from "./voice/VoicePicker";
import { GreetingPanel } from "./voice/GreetingPanel";
import { CollectPanel } from "./collect/CollectPanel";
import { HandoffPanel } from "./handoff/HandoffPanel";
import { AgentPicker } from "./agents/AgentPicker";
import { DocumentAgents } from "./knowledge/DocumentAgents";
import { NumbersPanel } from "./numbers/NumbersPanel";
import { fieldDef } from "@/lib/collect/config";
import { pick } from "@/lib/collect/catalog";

// Hidden until tool-calling actually executes (Phase 4, respond.js) — showing
// capability toggles for things the agent can only ever DESCRIBE, never do,
// invited confusion about what switching them on actually changes right now.
// Off is a display choice, not a data change: nothing here touches
// config.capabilities itself, so flipping this back on needs no migration.
const SHOW_CAPABILITIES = false;

// A light, explicit CodeMirror theme. Without one, CodeMirror's own default
// styling reads as near-white text on a white background in this app's light
// UI — the editor LOOKED broken (illegible) even though editing worked fine.
const editorTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#ffffff", color: "#111827", fontSize: "13px" },
    ".cm-content": { caretColor: "#111827" },
    ".cm-gutters": { backgroundColor: "#f9fafb", color: "#9ca3af", border: "none" },
    ".cm-activeLine": { backgroundColor: "#f3f4f6" },
    ".cm-activeLineGutter": { backgroundColor: "#f3f4f6" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "#bfdbfe !important",
    },
  },
  { dark: false }
);

// A plain overlay + panel, not a <dialog> — <dialog>'s built-in light-dismiss
// and focus trapping fight CodeMirror's own key handling (Escape, Tab) more
// than they help here. Escape-to-close and click-outside-to-close are wired
// by hand instead, and stopPropagation on the panel keeps a click landing on
// the editor from bubbling up and closing it.
function Modal({ title, onClose, children }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded bg-white shadow-xl md:max-w-3xl lg:max-w-4xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="text-sm font-medium">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

// Small inline icons (no icon library — three glyphs isn't worth a
// dependency) for the per-document row actions. `aria-label` on the BUTTON
// carries the same translated text a visible label would have; only the
// visible text is gone, not the accessible name.
const ICON_PROPS = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" };

function EditIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

/** Icon-only row action, coloured by intent (neutral/blue/red) instead of
 *  carrying a text label — `title` gives the same word back as a hover
 *  tooltip, and `aria-label` gives it to assistive tech. */
function IconButton({ onClick, disabled, label, color, children }) {
  const colors = {
    neutral: "border-gray-300 text-gray-600 hover:bg-gray-50",
    blue: "border-blue-300 text-blue-700 hover:bg-blue-50",
    red: "border-red-300 text-red-700 hover:bg-red-50",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`rounded border p-1.5 disabled:opacity-40 ${colors[color]}`}
    >
      {children}
    </button>
  );
}

// THE TEST CONSOLE.
//
// This is how we configure an agent and talk to it while the real channel —
// telephony — is built. It is an internal tool, not a product surface: every
// endpoint it calls is INTERNAL_API_KEY guarded, which is also why it only
// works while that variable is unset (i.e. on a dev machine).
//
// The embeddable chat widget that used to be here has been removed entirely.
// The chat panel below is a TEST HARNESS for the same brain a phone call will
// use, not a channel we ship.
//
// TWO LANGUAGE CONTROLS, and they answer different questions:
//   • Interface language     — changes THIS ENTIRE PAGE.
//   • Agent reply language   — English or Urdu. The agent understands both either way
//                              (and the two mixed); this is only what it answers in.

const DEFAULT_TENANT_ID = "test-tenant";
const TONES = ["professional", "friendly", "concise", "formal"];

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

// A provider outage or quota limit is TRANSIENT — retrying later can genuinely
// succeed, because nothing about the document itself was wrong. Shared by
// humanizeError (what to say) and isRetryableError (whether "Try again" makes
// sense) so the two classifications never drift apart.
const QUOTA_PATTERN = /RESOURCE_EXHAUSTED|exceeded your current quota|rate.?limit/i;
const UNAVAILABLE_PATTERN = /UNAVAILABLE|ECONNREFUSED|ECONNRESET|fetch failed|network/i;

/**
 * Turn a raw error — often a provider SDK's own error object stringified
 * wholesale, brace-shaped JSON and all (a Gemini quota error is a multi-line
 * JSON blob with internal links and a retry countdown) — into something a
 * business owner can read. Our OWN validation messages ("Document is too
 * large: 420 sections, limit 400") are already short, plain-English sentences
 * with no JSON shape, so those pass through untouched; anything that LOOKS
 * technical is matched against known signatures and replaced with a
 * translated, human message instead.
 */
function humanizeError(raw, t) {
  const message = String(raw ?? "").trim();
  if (!message) return t("dashboard:errors.generic");

  if (QUOTA_PATTERN.test(message)) return t("dashboard:errors.quotaExceeded");
  if (UNAVAILABLE_PATTERN.test(message)) return t("dashboard:errors.unavailable");
  // Our own thrown Errors are short, brace-free English sentences — safe as-is.
  if (!/[{}]/.test(message) && message.length <= 200) return message;

  return t("dashboard:errors.generic");
}

/**
 * Is this failure worth offering "Try again" for? A quota/outage error will
 * likely succeed on retry with the SAME content — no re-upload needed (see
 * retrySource in lib/agent/ingest.js). A validation error like "Document is
 * too large: 420 sections, limit 400" will fail again identically every
 * time; offering to retry it would just train people to click a button that
 * can never work.
 */
function isRetryableError(raw) {
  const message = String(raw ?? "");
  return QUOTA_PATTERN.test(message) || UNAVAILABLE_PATTERN.test(message);
}

export default function Home() {
  const [tenantId, setTenantId] = useState(DEFAULT_TENANT_ID);
  // Which of the tenant's agents every tab shows (CLAUDE.md §6.27). null until the agent list
  // has loaded; AgentPicker then picks the default agent.
  const [agentId, setAgentId] = useState(null);
  // False until the picker has resolved which agent to show — `null` alone cannot say it, since
  // null is also a real choice: the default agent of a tenant that has saved nothing yet.
  const [agentPicked, setAgentPicked] = useState(false);
  const [agentsKey, setAgentsKey] = useState(0);
  // Every agent of the tenant, archived included (from AgentPicker) — the Knowledge tab names
  // the agents a document is for and offers the active ones (§6.28).
  const [agentList, setAgentList] = useState([]);
  // Knowledge tab: show every document, or only those the picked agent answers from; and who a
  // NEW upload / typed document / crawled site is for.
  const [docFilter, setDocFilter] = useState("all");
  // The business's active phone numbers (§6.29) — the Numbers tab manages them, the Call tab can
  // ring one "as a caller would".
  const [numbers, setNumbers] = useState([]);
  const [newDocScope, setNewDocScope] = useState("all");
  const pickAgent = useCallback((id) => {
    setAgentId(id);
    setAgentPicked(true);
  }, []);
  const agentQuery = agentId ? `&agentId=${encodeURIComponent(agentId)}` : "";

  // --- the two languages ---
  const [uiLocale, setUiLocale] = useState("en");
  // Which part of the console is showing. The sections are independent screens that used to
  // be stacked on one long page; a tab each keeps "what does it collect" one click away.
  const [tab, setTab] = useState("agent");
  // True once this tenant's SAVED dashboard language has been applied.
  // A ref, not state: it must survive a refetch without causing one, and it
  // must not be stored on the config object — the previous version did exactly
  // that, every refetch replaced the object and lost the flag, and the
  // adoption then re-ran and overrode whatever language the user had picked.
  const adoptedRef = useRef(false);
  // The actual <input type="file"> lives off-screen — the visible "Upload
  // file" button just forwards its click here, so all three ingestion
  // actions can be styled as identical buttons in one row.
  const fileInputRef = useRef(null);

  // --- agent config ---
  const [config, setConfig] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [configStatus, setConfigStatus] = useState(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [reloadingConfig, setReloadingConfig] = useState(false);

  // --- knowledge ---
  const [docs, setDocs] = useState([]);
  const [limits, setLimits] = useState({ maxBytes: 0, extensions: [] });
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [dismissingJobs, setDismissingJobs] = useState(false);
  // Per-document id currently mid Edit/Delete/Try-again — every button on
  // that ONE row disables while any of the three is in flight, so a second
  // click can't fire a second request against a document already being
  // acted on (a double-click on Delete, say, must not send two DELETEs).
  const [busyDocIds, setBusyDocIds] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  // True while the "Write document" modal is open for a BRAND NEW document —
  // distinct from editingId, which is only set once a document already
  // exists. Both open the same Modal+editor; saveDoc already branches
  // correctly on editingId being null vs set.
  const [composerOpen, setComposerOpen] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docText, setDocText] = useState("");
  const [jobs, setJobs] = useState([]);
  // Bumped when an upload starts, to restart polling after it has gone quiet.
  const [jobEpoch, setJobEpoch] = useState(0);
  // True while the "Read website" row (url input + submit/cancel) is expanded
  // in place of the three-button row.
  const [crawlOpen, setCrawlOpen] = useState(false);
  const [crawlUrl, setCrawlUrl] = useState("");
  const [crawling, setCrawling] = useState(false);
  const [ingestStatus, setIngestStatus] = useState(null);
  const [ingesting, setIngesting] = useState(false);

  // --- chat ---
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const t = useMemo(() => translator(uiLocale), [uiLocale]);
  const dir = dirFor(uiLocale);

  // The capability catalog is re-fetched whenever the dashboard language
  // changes, because its labels are translated SERVER-side — the dashboard
  // never holds its own copy of that text.
  const loadConfig = useCallback(async () => {
    setConfigStatus(null);
    setReloadingConfig(true);
    try {
      const q = `tenantId=${encodeURIComponent(tenantId)}${agentQuery}&locale=${uiLocale}`;
      const [configRes, catalogRes] = await Promise.all([
        fetch(`/api/agent-config?${q}`),
        fetch(`/api/agent-config/catalog?locale=${uiLocale}`),
      ]);
      const configData = await readJsonSafe(configRes);
      if (!configRes.ok) throw new Error(configData.error || "Failed to load config");
      const catalogData = await readJsonSafe(catalogRes);
      if (!catalogRes.ok) throw new Error(catalogData.error || "Failed to load catalog");

      // ⚠️ DO NOT replace the whole config with the server's copy here.
      //
      // Changing the language dropdown re-runs this fetch (the capability
      // labels are translated server-side). The server returns the SAVED
      // language, which would overwrite the selection the user just made — so
      // picking English on a business saved as Urdu snapped straight back
      // to Urdu and the dropdown appeared broken.
      //
      // Once the saved language has been adopted, the in-flight choice wins
      // until it is saved or the page is reloaded.
      setConfig((prev) =>
        adoptedRef.current && prev
          ? { ...configData.config, uiLocale: prev.uiLocale }
          : configData.config
      );

      // Adopt the saved language ONCE, so the page opens in the language the
      // business chose. Tracked in a ref rather than on the config object: the
      // previous version kept an `__adopted` flag there, and every refetch
      // replaced the object and lost it — which is what let the adoption run
      // again and fight the user's selection.
      if (!adoptedRef.current) {
        adoptedRef.current = true;
        if (configData.config.uiLocale) setUiLocale(configData.config.uiLocale);
      }

      setCatalog(catalogData.capabilities);
      setConfigStatus(configData.config.exists ? t("common:state.saved") : null);
    } catch (err) {
      setConfigStatus(humanizeError(err.message, t));
    } finally {
      setReloadingConfig(false);
    }
  }, [tenantId, agentQuery, uiLocale, t]);

  useEffect(() => {
    // Wait for the agent list: loading "the default" first and the picked agent a moment
    // later would flash one agent's settings under another's name.
    if (agentPicked) loadConfig();
  }, [agentPicked, loadConfig]);

  useEffect(() => {
    // A different business has its own saved language to adopt, and its own agents.
    adoptedRef.current = false;
    setAgentId(null);
    setAgentPicked(false);
    setConversationId(null);
    setMessages([]);
  }, [tenantId]);

  useEffect(() => {
    // A conversation belongs to one agent: switching agents starts a new one. A selection in
    // the Knowledge tab may now be partly hidden by the "used by this agent" filter: drop it.
    setConversationId(null);
    setMessages([]);
    setSelectedIds(new Set());
  }, [agentId]);

  async function saveConfig(e) {
    e.preventDefault();
    setSavingConfig(true);
    setConfigStatus(null);
    try {
      const res = await fetch(
        `/api/agent-config?tenantId=${encodeURIComponent(tenantId)}${agentQuery}&locale=${uiLocale}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessName: config.businessName,
            purpose: config.purpose,
            tone: config.tone,
            uiLocale: config.uiLocale,
            replyLanguage: config.replyLanguage,
            capabilities: config.capabilities,
            voices: config.voices,
            greeting: config.greeting ?? {},
            recordCalls: Boolean(config.recordCalls),
            escalation: config.escalation,
          }),
        }
      );
      const data = await readJsonSafe(res);
      if (!res.ok) {
        throw new Error(data.details ? data.details.join(" · ") : data.error || "Save failed");
      }
      setConfig(data.config);
      setUiLocale(data.config.uiLocale);
      setConfigStatus(t("common:state.saved"));
      // The picker shows the business name of an unnamed agent: re-read it.
      setAgentsKey((k) => k + 1);
    } catch (err) {
      setConfigStatus(humanizeError(err.message, t));
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

  const loadDocs = useCallback(async () => {
    try {
      // With the agent named, each row says whether THIS agent answers from it (usedByAgent).
      const res = await fetch(
        `/api/knowledge?tenantId=${encodeURIComponent(tenantId)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : "&agentId="}&locale=${uiLocale}`
      );
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Failed to load documents");
      setDocs(data.sources);
      setLimits(data.limits);
      // Drop any selected id no longer in this list — a tenant switch or a
      // delete from another tab should fall out of "Delete selected (N)"
      // instead of leaving a stale count behind.
      setSelectedIds((prev) => {
        const validIds = new Set(data.sources.map((s) => s.id));
        const next = new Set([...prev].filter((id) => validIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    }
  }, [tenantId, agentId, uiLocale, t]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const loadNumbers = useCallback(async () => {
    try {
      const res = await fetch(`/api/numbers?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`);
      const data = await readJsonSafe(res);
      if (res.ok) setNumbers(data.numbers);
    } catch {
      // The numbers are a convenience on the Call tab; the Numbers tab shows its own errors.
    }
  }, [tenantId, uiLocale]);

  useEffect(() => {
    loadNumbers();
  }, [loadNumbers]);

  // ── who a document is for (§6.28) ──
  // Choosing only makes sense with two agents that can be chosen (an unsaved default has no id).
  const choosableAgents = agentList.filter((a) => a.id && a.status === "active");
  const multiAgent = choosableAgents.length > 1;
  // "All agents" sends NOTHING: a new document is then shared, and a REPLACED one keeps who it was
  // for — re-uploading the Dublin page must never quietly hand it to every branch.
  const newDocAgents = multiAgent && newDocScope === "agent" && agentId ? [agentId] : undefined;
  const visibleDocs = multiAgent && docFilter === "agent" ? docs.filter((d) => d.usedByAgent !== false) : docs;

  async function saveDocAgents(id, agents) {
    setBusyDocIds((prev) => new Set(prev).add(id));
    setIngestStatus(null);
    try {
      const res = await fetch(`/api/knowledge/${id}?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents }),
      });
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Save failed");
      await loadDocs();
      return true;
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
      return false;
    } finally {
      setBusyDocIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function resetDocForm() {
    setEditingId(null);
    setComposerOpen(false);
    setDocTitle("");
    setDocText("");
  }

  function openComposer() {
    setIngestStatus(null);
    setDocTitle("");
    setDocText("");
    setComposerOpen(true);
  }

  function openCrawl() {
    setIngestStatus(null);
    setCrawlOpen(true);
  }

  function closeCrawl() {
    setCrawlOpen(false);
    setCrawlUrl("");
  }

  // Saving REPLACES when the name already exists — the server deletes the old
  // chunks in the same transaction that writes the new ones. That is the whole
  // point of this panel: a business can correct a wrong price instead of
  // stacking a second copy of it on top of the first.
  async function saveDoc(e) {
    e.preventDefault();
    if (!docTitle.trim() || !docText.trim()) return;

    // CONFIRM BEFORE REPLACE — only for a NEW document (editingId null). An
    // actual edit is saving the SAME document back under its own title, which
    // is never a collision; renaming one into ANOTHER document's title is a
    // separate, already-guarded case (the PUT handler rejects it outright).
    if (!editingId) {
      const clash = docs.find((d) => d.title === docTitle.trim());
      if (
        clash &&
        !window.confirm(t("dashboard:knowledge.confirmReplace", { vars: { titles: clash.title } }))
      ) {
        return;
      }
    }

    setIngesting(true);
    setIngestStatus(null);
    try {
      const query = `tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`;
      const res = editingId
        ? await fetch(`/api/knowledge/${editingId}?${query}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: docTitle, text: docText }),
          })
        : await fetch(`/api/knowledge?${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: docTitle, text: docText, agents: newDocAgents }),
          });

      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Save failed");

      setIngestStatus(
        data.document?.replaced || editingId
          ? t("dashboard:knowledge.replaced")
          : t("dashboard:knowledge.added")
      );
      resetDocForm();
      await loadDocs();
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    } finally {
      setIngesting(false);
    }
  }

  // ---- import progress -----------------------------------------------------
  //
  // Polled rather than streamed: progress moves on chunk and page boundaries,
  // seconds apart, so a 1s poll loses nothing a person can perceive and avoids
  // a long-lived connection per open tab. Polling STOPS entirely once nothing
  // is running, so an idle dashboard makes no requests at all.
  const pollJobs = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/knowledge/jobs?tenantId=${encodeURIComponent(tenantId)}`
      );
      if (!res.ok) return false;
      const data = await readJsonSafe(res);
      setJobs(data.jobs);
      return data.active;
    } catch {
      // A failed poll is not worth surfacing — the next one usually succeeds,
      // and an error banner that flickers on a dropped request is worse than
      // a progress bar that pauses for a second.
      return false;
    }
  }, [tenantId]);

  useEffect(() => {
    let timer;
    let stopped = false;

    const tick = async () => {
      const active = await pollJobs();
      if (stopped) return;
      if (active) {
        timer = setTimeout(tick, 1000);
      } else {
        // Nothing running. Refresh the document list once — a finished import
        // has just added or replaced a row — then go quiet.
        await loadDocs();
      }
    };

    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // `jobEpoch` is bumped whenever an upload starts, which is what restarts
    // polling after it has gone quiet.
  }, [pollJobs, loadDocs, jobEpoch]);

  async function dismissJobs() {
    setDismissingJobs(true);
    try {
      await fetch(`/api/knowledge/jobs?tenantId=${encodeURIComponent(tenantId)}`, {
        method: "DELETE",
      });
      setJobs([]);
    } catch {
      // Cosmetic; the rows age out of the query on their own.
    } finally {
      setDismissingJobs(false);
    }
  }

  /** Human sentence for what a job is doing right now. */
  function jobLabel(job) {
    if (job.status === "done") return t("dashboard:jobs.done");
    if (job.status === "failed") return job.error ? humanizeError(job.error, t) : t("dashboard:jobs.failed");
    if (job.status === "cancelled") return t("dashboard:jobs.cancelled");
    return t(`dashboard:jobs.stage.${job.stage}`, {
      vars: { done: job.itemsDone, total: job.itemsTotal },
    });
  }

  // Only a queued or processing job can be cancelled — the server no-ops on
  // anything already finished. Optimistically flips this one row to
  // "cancelled" so the button disappears immediately instead of waiting for
  // the next 1s poll, which otherwise reads as the click having done nothing.
  async function cancelJobRow(id) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "cancelled" } : j)));
    try {
      await fetch(`/api/knowledge/jobs/${id}?tenantId=${encodeURIComponent(tenantId)}`, {
        method: "DELETE",
      });
    } catch {
      // The next poll reconciles with the server's actual state either way.
    } finally {
      await loadDocs();
    }
  }

  // Crawling is queued as a background job on the server — same reason
  // uploads are: several page fetches plus an embedding per chunk can run well
  // past a request timeout. This used to read `data.document.pagesCrawled`
  // straight off the POST response, which only ever made sense when crawling
  // was synchronous; since the server answers with a job id (202) the field
  // was always undefined and crawling a website threw
  // "Cannot read properties of undefined (reading 'pagesCrawled')" before it
  // ever got a chance to run. It now follows the exact same fire-and-forget +
  // poll pattern as uploadDocs(), and the shared job progress panel below
  // reports the outcome.
  async function crawlWebsite() {
    const url = crawlUrl.trim();
    if (!url) return;

    // CONFIRM BEFORE REPLACE. The server titles a crawl by the site's host
    // (no title field is sent here) — replicated client-side just for this
    // check, so a re-crawl of a site already in the list gets the same
    // confirmation an upload or a typed document would.
    let host;
    try {
      host = new URL(url).host;
    } catch {
      // An invalid URL is reported by the server's own validation below;
      // this check simply has nothing to compare in that case.
    }
    const clash = host && docs.find((d) => d.title === host);
    if (clash && !window.confirm(t("dashboard:knowledge.confirmReplace", { vars: { titles: host } }))) {
      return;
    }

    setCrawling(true);
    setIngestStatus(null);
    try {
      const res = await fetch(
        `/api/knowledge?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, maxPages: 10, agents: newDocAgents }),
        }
      );
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Could not read that website");
      closeCrawl();
      setJobEpoch((n) => n + 1);
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    } finally {
      setCrawling(false);
    }
  }

  // MANY FILES, ONE REQUEST, ONE JOB EACH.
  //
  // The server queues each file separately and answers immediately with job
  // ids, so this returns in milliseconds however large the files are — the
  // reading, OCR and embedding all happen behind the progress bars.
  async function uploadDocs(files) {
    const list = [...(files ?? [])];
    if (!list.length) return;

    // CONFIRM BEFORE REPLACE. A file whose name matches an existing document
    // silently overwrote it — the server's "replace, don't append" rule
    // (lib/agent/ingest.js) is correct for the workflow it was built for
    // (fixing a wrong price and re-uploading), but nothing stopped it from
    // firing on an accidental name collision too. Checked against the
    // already-loaded list, so this is a UX courtesy — the server enforces the
    // real rule regardless.
    const existingTitles = new Set(docs.map((d) => d.title));
    const collisions = list.filter((f) => existingTitles.has(f.name));
    if (
      collisions.length &&
      !window.confirm(
        t("dashboard:knowledge.confirmReplace", {
          vars: { titles: collisions.map((f) => f.name).join(", ") },
        })
      )
    ) {
      return;
    }

    setIngesting(true);
    setIngestStatus(null);
    try {
      const form = new FormData();
      for (const file of list) form.append("file", file);
      if (newDocAgents) form.append("agents", JSON.stringify(newDocAgents));

      const res = await fetch(
        `/api/knowledge?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`,
        { method: "POST", body: form }
      );
      const data = await readJsonSafe(res);
      if (!res.ok && !data.jobs?.length) throw new Error(data.error || "Upload failed");

      // Files the server refused (wrong type, too large) are reported per file
      // rather than failing the batch — nine good files should still import.
      if (data.rejected?.length) {
        setIngestStatus(
          `${t("dashboard:knowledge.rejected", { vars: { count: data.rejected.length } })}: ` +
            data.rejected.map((r) => `${r.fileName} — ${r.error}`).join(" · ")
        );
      }

      // Restart polling: it stops when nothing is running, and this is the
      // moment something is.
      setJobEpoch((n) => n + 1);
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    } finally {
      setIngesting(false);
    }
  }

  function markDocBusy(id, busy) {
    setBusyDocIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Loads the ORIGINAL text back into the form. Chunks are derived data; this
  // is what the business actually wrote, or what we extracted from their file.
  async function editDoc(id) {
    setIngestStatus(null);
    markDocBusy(id, true);
    try {
      const res = await fetch(
        `/api/knowledge/${id}?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`
      );
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Could not open document");
      setEditingId(id);
      setDocTitle(data.document.title);
      setDocText(data.document.content);
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    } finally {
      markDocBusy(id, false);
    }
  }

  // Re-embeds a FAILED document using what's already stored — no re-upload,
  // no new Cloudinary call (see lib/agent/ingest.js retrySource). Queued as a
  // background job like any other import, so it gets the same progress bar
  // and can be cancelled the same way.
  async function retryDoc(id) {
    setIngestStatus(null);
    markDocBusy(id, true);
    try {
      const res = await fetch(
        `/api/knowledge/${id}/retry?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`,
        { method: "POST" }
      );
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Could not retry that document");
      setJobEpoch((n) => n + 1);
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    } finally {
      // Left busy a beat longer would be wrong here: the retry is now a
      // QUEUED JOB, not an in-flight request, so there is nothing further for
      // this row's buttons to wait on — the job panel takes over from here.
      markDocBusy(id, false);
    }
  }

  async function deleteDoc(id) {
    if (!window.confirm(t("dashboard:knowledge.confirmDelete"))) return;
    setIngestStatus(null);
    markDocBusy(id, true);
    try {
      const res = await fetch(
        `/api/knowledge/${id}?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`,
        { method: "DELETE" }
      );
      const data = await readJsonSafe(res);
      if (!res.ok) throw new Error(data.error || "Delete failed");
      if (editingId === id) resetDocForm();
      setSelectedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setIngestStatus(t("dashboard:knowledge.deleted"));
      await loadDocs();
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    } finally {
      markDocBusy(id, false);
    }
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    // Only what is on screen: a filter must never let "select all" delete documents it hides.
    setSelectedIds((prev) => (prev.size === visibleDocs.length ? new Set() : new Set(visibleDocs.map((d) => d.id))));
  }

  // Reuses the same single-document DELETE the row button calls, in parallel —
  // there is no bulk endpoint, and there does not need to be one: each delete
  // is already its own transaction (cascade the chunks, then best-effort clean
  // up Cloudinary), so N of them are just N independent calls.
  async function deleteSelected() {
    if (!selectedIds.size) return;
    if (
      !window.confirm(
        t("dashboard:knowledge.confirmDeleteMany", { vars: { count: selectedIds.size } })
      )
    ) {
      return;
    }
    setIngestStatus(null);
    setDeletingSelected(true);
    const ids = [...selectedIds];
    try {
      const results = await Promise.all(
        ids.map((id) =>
          fetch(`/api/knowledge/${id}?tenantId=${encodeURIComponent(tenantId)}&locale=${uiLocale}`, {
            method: "DELETE",
          }).then((res) => res.ok)
        )
      );
      const failedCount = results.filter((ok) => !ok).length;
      if (editingId && ids.includes(editingId)) resetDocForm();
      setSelectedIds(new Set());
      setIngestStatus(
        failedCount
          ? t("dashboard:knowledge.deleteManyPartial", {
              vars: { done: ids.length - failedCount, failed: failedCount },
            })
          : t("dashboard:knowledge.deletedMany", { vars: { count: ids.length } })
      );
      await loadDocs();
    } catch (err) {
      setIngestStatus(humanizeError(err.message, t));
    } finally {
      setDeletingSelected(false);
    }
  }

  // Streams from /api/chat. Streaming is kept in the test console on purpose:
  // voice needs token-by-token output to start speaking before a sentence is
  // finished, so the path stays exercised rather than being rebuilt later.
  async function handleSend(e) {
    e.preventDefault();
    if (!input.trim() || sending) return;

    const userMessage = input;
    setInput("");
    setMessages((p) => [...p, { role: "user", content: userMessage }]);
    setSending(true);

    try {
      const res = await fetch(`/api/chat?tenantId=${encodeURIComponent(tenantId)}${agentQuery}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage, conversationId }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamingStarted = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line, and a frame can arrive split
        // across reads — so whatever follows the last separator stays buffered.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = (frame.match(/^event: (.*)$/m) || [])[1];
          const data = (frame.match(/^data: (.*)$/m) || [])[1];
          if (!data) continue;
          const payload = JSON.parse(data);

          if (event === "session") {
            setConversationId(payload.conversationId);
          } else if (event === "chunk") {
            streamingStarted = true;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.pending) {
                return [...prev.slice(0, -1), { ...last, content: last.content + payload.text }];
              }
              return [...prev, { role: "assistant", content: payload.text, pending: true }];
            });
          } else if (event === "done") {
            // model/sources are debug metadata from respond() (see
            // lib/agent/respond.js) — which provider actually answered, and
            // which of the tenant's documents (if any) it was grounded in.
            // Attached to the bubble, never spoken or sent anywhere else.
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === "assistant" && last.pending) {
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    pending: false,
                    model: payload.model,
                    sources: payload.sources,
                    searchQuery: payload.searchQuery,
                    rewriteStatus: payload.rewriteStatus,
                    collection: payload.collection,
                    handoff: payload.handoff,
                  },
                ];
              }
              return streamingStarted
                ? prev
                : [
                    ...prev,
                    {
                      role: "assistant",
                      content: payload.reply,
                      model: payload.model,
                      sources: payload.sources,
                      searchQuery: payload.searchQuery,
                      rewriteStatus: payload.rewriteStatus,
                      collection: payload.collection,
                      handoff: payload.handoff,
                    },
                  ];
            });
          } else if (event === "error") {
            throw new Error(payload.message);
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        // Drop a half-streamed reply: a truncated sentence next to an error
        // reads as though the agent said something it never finished.
        ...prev.filter((m) => !(m.role === "assistant" && m.pending)),
        { role: "error", content: humanizeError(err.message, t) },
      ]);
    } finally {
      setSending(false);
    }
  }

  const label = "mb-1 block text-xs font-medium";
  const help = "mt-1 text-xs text-gray-500";
  const inputCls = "w-full rounded border border-gray-300 px-3 py-2 text-sm";
  const card = "rounded border border-gray-200 p-4";
  const btn = "rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40";

  return (
    <div dir={dir} lang={uiLocale} className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("dashboard:agent.title")}</h1>
          <p className="text-sm text-gray-500">{t("dashboard:agent.subtitle")}</p>
        </div>
        <div>
          <label className={label} htmlFor="ui-locale">
            {t("dashboard:field.uiLocale.label")}
          </label>
          <select
            id="ui-locale"
            className="rounded border border-gray-300 px-2 py-1 text-sm"
            value={uiLocale}
            onChange={(e) => {
              setUiLocale(e.target.value);
              patchConfig({ uiLocale: e.target.value });
            }}
          >
            {LOCALE_META.map((l) => (
              <option key={l.code} value={l.code}>{l.nativeName}</option>
            ))}
          </select>
          <p className={help}>{t("dashboard:field.uiLocale.help")}</p>
        </div>
      </header>

      <div>
        <label className={label} htmlFor="tenant">Tenant ID</label>
        <input id="tenant" className={inputCls} value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
      </div>

      <AgentPicker
        tenantId={tenantId}
        uiLocale={uiLocale}
        value={agentId}
        onChange={pickAgent}
        onAgentsLoaded={setAgentList}
        refreshKey={agentsKey}
        t={t}
        cardClass={card}
        inputClass={inputCls}
        buttonClass="rounded border border-gray-300 px-3 py-1.5 text-sm"
        helpClass={help}
      />

      <nav className="flex flex-wrap gap-1 border-b border-gray-200" role="tablist" aria-label={t("dashboard:agent.title")}>
        {["agent", "knowledge", "collect", "numbers", "call", "chat"].map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`-mb-px rounded-t border border-b-0 px-4 py-2 text-sm ${tab === id ? "border-gray-300 bg-white font-medium text-black" : "border-transparent text-gray-500 hover:text-white"}`}
          >
            {t(`dashboard:tab.${id}`)}
          </button>
        ))}
      </nav>

      {tab === "agent" && (
        <>
      {!config ? (
          <p className="text-sm text-gray-400">{t("common:state.loading")}</p>
        ) : (
          <form onSubmit={saveConfig} className={`${card} flex flex-col gap-4`}>
            <div>
              <label className={label} htmlFor="bn">{t("dashboard:field.businessName.label")}</label>
              <input id="bn" className={inputCls} value={config.businessName}
                onChange={(e) => patchConfig({ businessName: e.target.value })} />
              <p className={help}>{t("dashboard:field.businessName.help")}</p>
            </div>
  
            <div>
              <label className={label} htmlFor="purpose">{t("dashboard:field.purpose.label")}</label>
              <textarea id="purpose" className={`${inputCls} min-h-20`}
                placeholder={t("dashboard:field.purpose.placeholder")}
                value={config.purpose} onChange={(e) => patchConfig({ purpose: e.target.value })} />
              <p className={help}>{t("dashboard:field.purpose.help")}</p>
            </div>
  
            <div className="flex flex-wrap gap-3">
              <div className="flex-1">
                <label className={label} htmlFor="tone">{t("dashboard:field.tone.label")}</label>
                <select id="tone" className={inputCls} value={config.tone}
                  onChange={(e) => patchConfig({ tone: e.target.value })}>
                  {TONES.map((tone) => (
                    <option key={tone} value={tone}>{t(`common:tone.${tone}`)}</option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className={label} htmlFor="reply">
                  {t("dashboard:field.replyLanguage.label")}
                </label>
                <select id="reply" className={inputCls} value={config.replyLanguage}
                  onChange={(e) => patchConfig({ replyLanguage: e.target.value })}>
                  {REPLY_LANGUAGES.map((r) => (
                    <option key={r} value={r}>{t(`common:replyLanguage.${r}`)}</option>
                  ))}
                </select>
                <p className={help}>{t("dashboard:field.replyLanguage.help")}</p>
              </div>
            </div>
  
            <VoicePicker
              voices={config.voices ?? {}}
              replyLanguage={config.replyLanguage}
              onChange={(voices) => patchConfig({ voices })}
              t={t}
              labelClass={label}
              helpClass={help}
              inputClass={inputCls}
            />

            <GreetingPanel
              config={config}
              onChange={patchConfig}
              t={t}
              labelClass={label}
              helpClass={help}
              inputClass={inputCls}
            />
  
            <HandoffPanel
              key={`${tenantId}:${config.agentId ?? ""}:${config.updatedAt ?? 0}`}
              value={config.escalation}
              onChange={(escalation) => patchConfig({ escalation })}
              t={t}
              labelClass={label}
              helpClass={help}
              inputClass={inputCls}
              buttonClass="rounded border border-gray-300 px-3 py-1.5 text-sm"
            />
  
            {SHOW_CAPABILITIES && (
              <div>
                <span className={label}>{t("dashboard:capabilities.title")}</span>
                <p className={`${help} mb-2`}>{t("dashboard:capabilities.help")}</p>
                <div className="flex flex-col gap-2">
                  {catalog.map((cap) => (
                    <label key={cap.id} className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1"
                        checked={Boolean(config.capabilities?.[cap.id]?.enabled)}
                        onChange={(e) => toggleCapability(cap.id, e.target.checked)} />
                      <span>
                        {cap.label}
                        {cap.setupNote && (
                          <span className="ms-1 text-xs text-amber-600">{cap.setupNote}</span>
                        )}
                        <span className="block text-xs text-gray-500">{cap.description}</span>
                        <span className="block text-xs text-gray-400">
                          {t("dashboard:capabilities.channelsLabel")}:{" "}
                          {cap.channels.map((c) => cap.channelLabels[c]).join(" · ")}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
  
            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={savingConfig} className={btn}>
                {savingConfig ? t("common:state.saving") : t("common:action.save")}
              </button>
              <button type="button" onClick={loadConfig} disabled={reloadingConfig}
                className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40">
                {t("common:action.reload")}
              </button>
              {configStatus && <p className="text-sm">{configStatus}</p>}
            </div>
          </form>
        )}
        </>
      )}

      {tab === "knowledge" && (
      <section className={card}>
          <h2 className="mb-1 font-medium">{t("dashboard:knowledge.title")}</h2>
          <p className={`${help} mb-3`}>{t("dashboard:knowledge.help")}</p>

          {/* ---- ONE library, several agents (§6.28): who new documents are for, and which to list ---- */}
          {multiAgent && (
            <div className="mb-3 flex flex-col gap-2 rounded border border-gray-200 p-2 text-sm" data-testid="knowledge-scope">
              <label className="flex flex-wrap items-center gap-2">
                <span>{t("dashboard:knowledgeAgents.newFor")}</span>
                <select className="rounded border border-gray-300 px-2 py-1" value={newDocScope} onChange={(e) => setNewDocScope(e.target.value)}>
                  <option value="all">{t("dashboard:knowledgeAgents.allOption")}</option>
                  <option value="agent">{t("dashboard:knowledgeAgents.onlyCurrent", { vars: { name: (choosableAgents.find((a) => a.id === agentId)?.name || choosableAgents.find((a) => a.id === agentId)?.businessName || "") } })}</option>
                </select>
              </label>
              <p className={help}>{t("dashboard:knowledgeAgents.newForHelp")}</p>
              <label className="flex flex-wrap items-center gap-2">
                <span>{t("dashboard:knowledgeAgents.show")}</span>
                <select className="rounded border border-gray-300 px-2 py-1" value={docFilter} onChange={(e) => {
                  setDocFilter(e.target.value);
                  // A hidden document must never stay selected for "delete selected".
                  setSelectedIds(new Set());
                }}>
                  <option value="all">{t("dashboard:knowledgeAgents.showAll")}</option>
                  <option value="agent">{t("dashboard:knowledgeAgents.showUsed", { vars: { name: (choosableAgents.find((a) => a.id === agentId)?.name || choosableAgents.find((a) => a.id === agentId)?.businessName || "") } })}</option>
                </select>
              </label>
            </div>
          )}
  
          {/* ---- the three ways to teach the agent something, always on top ---- */}
          {!crawlOpen ? (
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={ingesting}
                className={btn}
              >
                {t("dashboard:knowledge.upload")}
              </button>
              <button type="button" onClick={openComposer} className={btn}>
                {t("dashboard:knowledge.addText")}
              </button>
              <button type="button" onClick={openCrawl} className={btn}>
                {t("dashboard:knowledge.crawlButton")}
              </button>
              {/* The real file input stays off-screen — its native "Choose files"
                  button can't be restyled to match the other two, so a plain
                  button forwards its click here instead. */}
              <input
                ref={fileInputRef}
                id="doc-file"
                type="file"
                multiple
                accept={limits.extensions?.join(",")}
                disabled={ingesting}
                onChange={(e) => {
                  const files = e.target.files;
                  // Cleared so choosing the SAME file twice still fires a
                  // change — the common case when someone fixes a document and
                  // re-uploads it.
                  const picked = files ? [...files] : [];
                  e.target.value = "";
                  uploadDocs(picked);
                }}
                className="hidden"
              />
            </div>
          ) : (
            <div className="mb-4 flex flex-col gap-2">
              <input
                type="url"
                autoFocus
                className={inputCls}
                placeholder={t("dashboard:knowledge.crawlPlaceholder")}
                value={crawlUrl}
                onChange={(e) => setCrawlUrl(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={crawlWebsite}
                  disabled={crawling || !crawlUrl.trim()}
                  className={btn}
                >
                  {crawling ? t("dashboard:knowledge.crawling") : t("dashboard:knowledge.crawlButton")}
                </button>
                <button
                  type="button"
                  onClick={closeCrawl}
                  disabled={crawling}
                  className="rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-40"
                >
                  {t("common:action.cancel")}
                </button>
              </div>
            </div>
          )}
          <p className={`${help} mb-4`}>
            {crawlOpen ? (
              t("dashboard:knowledge.crawlHelp")
            ) : (
              <>
                {t("dashboard:knowledge.uploadMany")}{" "}
                {t("dashboard:knowledge.uploadHelp", {
                  vars: {
                    types: (limits.extensions ?? []).join(" "),
                    max: Math.round((limits.maxBytes ?? 0) / (1024 * 1024)),
                  },
                })}
              </>
            )}
          </p>
          {ingestStatus && <p className="mb-4 text-sm">{ingestStatus}</p>}
  
          {/* ---- queued / in-progress imports ---- */}
          {jobs.length > 0 && (
            <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {t("dashboard:jobs.title")}
                </p>
                {jobs.every((j) => j.status === "done" || j.status === "failed" || j.status === "cancelled") && (
                  <button
                    type="button"
                    onClick={dismissJobs}
                    disabled={dismissingJobs}
                    className="text-xs text-gray-500 underline disabled:opacity-40"
                  >
                    {t("dashboard:jobs.dismiss")}
                  </button>
                )}
              </div>
  
              <ul className="flex flex-col gap-2.5">
                {jobs.map((job) => {
                  const failed = job.status === "failed";
                  const done = job.status === "done";
                  const cancelled = job.status === "cancelled";
                  const active = !failed && !done && !cancelled;
                  return (
                    <li key={job.id}>
                      <div className="mb-1 flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium text-black">{job.title}</span>
                        <span className="flex flex-none items-center gap-2">
                          <span
                            className={`text-xs ${
                              failed
                                ? "text-red-600"
                                : done
                                  ? "text-green-700"
                                  : cancelled
                                    ? "text-gray-400"
                                    : "text-gray-500"
                            }`}
                          >
                            {jobLabel(job)}
                          </span>
                          {/* A long import (a big PDF's OCR, an embedding queue) can
                              run for minutes — this is the way out of it without
                              waiting, and lib/agent/jobs.js + ingest.js make sure
                              cancelling also removes whatever the job had already
                              written: the row, its chunks, and any Cloudinary
                              upload. */}
                          {active && (
                            <button
                              type="button"
                              onClick={() => cancelJobRow(job.id)}
                              className="text-xs text-gray-500 underline"
                            >
                              {t("common:action.cancel")}
                            </button>
                          )}
                        </span>
                      </div>
  
                      {/* A REAL bar: width is the job's actual progress, never an
                          animation pretending to be one. */}
                      <div
                        className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200"
                        role="progressbar"
                        aria-valuenow={job.progress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={job.title}
                      >
                        <div
                          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
                            failed
                              ? "bg-red-500"
                              : done
                                ? "bg-green-600"
                                : cancelled
                                  ? "bg-gray-400"
                                  : "bg-black"
                          }`}
                          style={{ width: `${failed || cancelled ? 100 : job.progress}%` }}
                        />
                      </div>
  
                      {/* OCR is markedly slower than the rest; saying why stops it
                          reading as a stall. */}
                      {job.stage === "ocr" && (
                        <p className="mt-1 text-xs text-amber-700">
                          {t("dashboard:jobs.scannedNote")}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
  
          {/* ---- existing documents ---- */}
          {docs.length === 0 ? (
            <p className="mb-4 text-sm text-gray-400">{t("dashboard:knowledge.empty")}</p>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs text-gray-500">
                  <input
                    type="checkbox"
                    checked={visibleDocs.length > 0 && selectedIds.size === visibleDocs.length}
                    onChange={toggleSelectAll}
                  />
                  {t("dashboard:knowledge.selectAll")}
                </label>
                {selectedIds.size > 0 && (
                  <button
                    type="button"
                    onClick={deleteSelected}
                    disabled={deletingSelected}
                    className="rounded border border-red-300 px-3 py-1 text-xs text-red-700 disabled:opacity-40"
                  >
                    {t("dashboard:knowledge.deleteSelected", { vars: { count: selectedIds.size } })}
                  </button>
                )}
              </div>
              <ul className="mb-4 flex flex-col divide-y divide-gray-200 border-y border-gray-200">
                {visibleDocs.map((d) => (
                  <li key={d.id} className={`flex flex-wrap items-center gap-2 py-2 ${d.usedByAgent === false ? "opacity-60" : ""}`}>
                    <input
                      type="checkbox"
                      className="flex-none"
                      checked={selectedIds.has(d.id)}
                      onChange={() => toggleSelected(d.id)}
                      aria-label={d.title}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{d.title}</p>
                      <p className="text-xs text-gray-500">
                        {d.status === "ready"
                          ? t("dashboard:knowledge.chunks", { vars: { count: d.chunkCount } })
                          : d.status === "processing"
                            ? t("dashboard:knowledge.status.processing")
                            : t("dashboard:knowledge.status.failed")}
                        {d.kind === "file" && d.fileName ? ` · ${d.fileName}` : ""}
                        {d.byteSize ? ` · ${Math.max(1, Math.round(d.byteSize / 1024))} KB` : ""}
                      </p>
                      {d.status === "failed" && d.error && (
                        <p className="text-xs text-red-600">{humanizeError(d.error, t)}</p>
                      )}
                      {multiAgent && (
                        <>
                          <DocumentAgents
                            key={`${d.id}:${(d.agents ?? []).join(",")}`}
                            doc={d}
                            agents={agentList}
                            busy={busyDocIds.has(d.id)}
                            onSave={(agents) => saveDocAgents(d.id, agents)}
                            t={t}
                          />
                          {d.usedByAgent === false && (
                            <p className="text-xs text-gray-500">{t("dashboard:knowledgeAgents.notUsedHere")}</p>
                          )}
                        </>
                      )}
                    </div>
                    {/* Only documents whose STORED TEXT IS THE DOCUMENT can be
                        edited — typed text, .txt, .md. A PDF or Word file is stored
                        as text we extracted from it, and that extraction is lossy;
                        offering an edit box would present our approximation as if it
                        were their file. For those the honest action is to upload a
                        corrected version, which replaces it. */}
                    {/* Only for a TRANSIENT failure (quota, an outage) — see
                        isRetryableError. A document that failed for a reason
                        retrying can't fix (too large, no text) doesn't get this
                        button, since it would just fail again identically. */}
                    {d.status === "failed" && isRetryableError(d.error) && (
                      <IconButton
                        onClick={() => retryDoc(d.id)}
                        disabled={busyDocIds.has(d.id)}
                        label={t("common:action.retry")}
                        color="blue"
                      >
                        <RetryIcon />
                      </IconButton>
                    )}
                    {d.editable ? (
                      <IconButton
                        onClick={() => editDoc(d.id)}
                        disabled={busyDocIds.has(d.id)}
                        label={t("dashboard:knowledge.edit")}
                        color="neutral"
                      >
                        <EditIcon />
                      </IconButton>
                    ) : (
                      <span
                        className="text-xs text-gray-400"
                        title={t("dashboard:knowledge.notEditable")}
                      >
                        {d.kind === "url" ? "url" : (d.fileName?.split(".").pop() ?? "file")}
                      </span>
                    )}
                    <IconButton
                      onClick={() => deleteDoc(d.id)}
                      disabled={busyDocIds.has(d.id)}
                      label={t("common:action.delete")}
                      color="red"
                    >
                      <TrashIcon />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </>
          )}
  
        </section>
      )}

      {/* ---- write a new document, or edit an existing one, in a real editor ---- */}
      {(editingId || composerOpen) && (
        <Modal
          title={t(editingId ? "dashboard:knowledge.editing" : "dashboard:knowledge.addText")}
          onClose={resetDocForm}
        >
          <form onSubmit={saveDoc} className="flex flex-col gap-3">
            <div>
              <input
                className={inputCls}
                placeholder={t("dashboard:knowledge.docName")}
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
              />
              <p className={help}>{t("dashboard:knowledge.docNameHelp")}</p>
            </div>
            {/* CodeMirror rather than a plain textarea: line wrapping, find
                (Ctrl/Cmd+F), undo history and a monospace layout that makes a
                multi-section document's structure visible while editing it —
                a document this size in a plain <textarea> is a wall of text
                with no way to search it. Markdown-aware highlighting matches
                what's actually in here: chunk.js splits on `#` headings, and
                Word uploads arrive as markdown too (lib/agent/extract.js).
                A fixed light theme + lineWrapping keep it readable — without
                them CodeMirror's own default styling reads as near-invisible
                text and a document has to scroll sideways to read a line. The
                height scales up on larger screens, since a code-editor-style
                box this small is cramped for anything but a phone. */}
            <div className="h-[45vh] overflow-hidden rounded border border-gray-300 sm:h-[50vh] md:h-[60vh]">
              <CodeMirror
                value={docText}
                onChange={setDocText}
                theme={editorTheme}
                placeholder={t("dashboard:knowledge.docText")}
                extensions={[markdown(), EditorView.lineWrapping]}
                height="100%"
                // height="100%" alone isn't enough: @uiw/react-codemirror
                // renders its OWN wrapper div (.cm-theme) around the actual
                // editor with no sizing of its own, so a percentage height
                // on .cm-editor had nothing real to be 100% OF — it collapsed
                // to content height instead of filling this container. This
                // style prop lands directly on that wrapper (via the
                // library's own "other props" passthrough) and completes the
                // chain down to the parent div's actual height above.
                style={{ height: "100%" }}
                basicSetup={{ lineNumbers: true, foldGutter: false }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={ingesting || !docTitle.trim() || !docText.trim()}
                className={btn}
              >
                {ingesting ? t("common:state.saving") : t("common:action.save")}
              </button>
              <button
                type="button"
                onClick={resetDocForm}
                className="rounded border border-gray-300 px-4 py-2 text-sm"
              >
                {t("common:action.cancel")}
              </button>
              {ingestStatus && <p className="text-sm">{ingestStatus}</p>}
            </div>
          </form>
        </Modal>
      )}

      {tab === "collect" && (
        <CollectPanel
          key={agentId ?? "default"}
          tenantId={tenantId}
          agentId={agentId}
          uiLocale={uiLocale}
          replyLanguage={config?.replyLanguage}
          t={t}
          cardClass={card}
          labelClass={label}
          helpClass={help}
          inputClass={inputCls}
          buttonClass={btn}
        />
      )}

      {tab === "numbers" && (
        <NumbersPanel
          tenantId={tenantId}
          uiLocale={uiLocale}
          numbers={numbers}
          agents={agentList}
          onChanged={loadNumbers}
          t={t}
          cardClass={card}
          inputClass={inputCls}
          buttonClass="rounded border border-gray-300 px-3 py-1.5 text-sm"
          helpClass={help}
          labelClass={label}
        />
      )}

      {tab === "call" && (
        <>
      {/* The voice channel — the product (§1). Same brain as the chat below; it runs in
            its own process (npm run voice), see src/lib/voice/gateway.js. */}
        <VoiceCallPanel tenantId={tenantId} agentId={agentId} numbers={numbers} agents={agentList} uiLocale={uiLocale} t={t} dir={dir} cardClass={card} />
        </>
      )}

      {tab === "chat" && (
      <section className={`${card} flex flex-1 flex-col`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">{t("common:channel.chat")}</h2>
            <div className="flex items-center gap-2">
              {/* No language toggle here on purpose: this panel is rendered in the
                  INTERFACE language, and what the agent writes back is governed by
                  the reply-language setting above. */}
              <button type="button"
                onClick={() => { setConversationId(null); setMessages([]); }}
                className="rounded border border-gray-300 px-3 py-1 text-sm">
                {t("dashboard:chat.startNew")}
              </button>
            </div>
          </div>
  
          <div dir={dir} className="mb-3 flex min-h-40 flex-1 flex-col gap-2 overflow-y-auto">
            {messages.length === 0 && (
              <p className="text-sm text-gray-400">{t("dashboard:chat.empty")}</p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "self-end" : "self-start"}>
                <div className={
                  m.role === "user"
                    ? "rounded bg-black px-3 py-2 text-sm text-white"
                    : m.role === "error"
                      ? "rounded border border-dashed border-red-300 px-3 py-2 text-sm text-red-700"
                      : "rounded bg-gray-100 px-3 py-2 text-sm text-black"
                }>
                  {m.content}
                </div>
                {/* DEBUG METADATA — which model answered and which of the
                    tenant's documents (if any) it drew from. This is why the
                    test chat exists: proving a prompt/retrieval change without
                    digging through server logs. Shown only once the reply has
                    actually finished, and never for the user's own messages. */}
                {m.role === "assistant" && !m.pending && m.model && (
                  <p className="mt-1 text-xs text-gray-400">
                    {t("dashboard:chat.answeredBy", { vars: { model: m.model } })}
                    {" · "}
                    {m.sources?.length
                      ? t("dashboard:chat.groundedIn", { vars: { sources: m.sources.join(", ") } })
                      : t("dashboard:chat.noSources")}
                    {/* What was actually SEARCHED, when that differs from what
                        the customer typed — a follow-up like "and the Pro one?"
                        is rewritten into a standalone query first (§6.19). A
                        failed rewrite is shown too: it silently falls back to
                        the raw message, and that must not be invisible. */}
                    {m.searchQuery && (
                      <>
                        {" · "}
                        {t("dashboard:chat.searchedFor", { vars: { query: m.searchQuery } })}
                      </>
                    )}
                    {m.rewriteStatus === "failed" && (
                      <>
                        {" · "}
                        {t("dashboard:chat.searchRewriteFailed")}
                      </>
                    )}
                    {m.rewriteStatus === "skipped" && (
                      <>
                        {" · "}
                        {t("dashboard:chat.searchRewriteSkipped")}
                      </>
                    )}
                    {/* What happened to a customer's request this turn (appointment,
                        callback…): which detail the agent is asking for, or the reference
                        it was saved under. Idle (a request COULD be taken) is not news. */}
                    {/* The conversation is being passed to a person (or could not be). */}
                    {m.handoff && (
                      <>
                        {" · "}
                        {t(`dashboard:chat.handoff.${m.handoff.kind}`, {
                          vars: { who: [m.handoff.contact?.role, m.handoff.contact?.name].filter(Boolean).join(" — ") },
                        })}
                      </>
                    )}
                    {m.collection && m.collection.state !== "idle" && (
                      <>
                        {" · "}
                        {t(`dashboard:chat.request.${m.collection.state}`, {
                          vars: {
                            field: m.collection.field ? pick(fieldDef(config?.collect, m.collection.field)?.label, uiLocale) || m.collection.field : "",
                            reference: m.collection.reference ?? "",
                          },
                        })}
                      </>
                    )}
                  </p>
                )}
              </div>
            ))}
          </div>
  
          <form onSubmit={handleSend} dir={dir} className="flex gap-2">
            <input className={`${inputCls} flex-1`} placeholder={t("dashboard:chat.placeholder")}
              value={input} onChange={(e) => setInput(e.target.value)} />
            <button type="submit" disabled={sending} className={btn}>
              {sending ? t("dashboard:chat.typing") : t("dashboard:chat.send")}
            </button>
          </form>
          <p dir={dir} className="mt-2 text-xs text-gray-400">
            {t("dashboard:chat.disclaimer")}
          </p>
        </section>
      )}
    </div>
  );
}
