# Engine ⇄ Backend hand-off

**Audience:** Abdul Haseeb (backend / multi-tenant platform) — and any AI assistant given this document
together with this repository. Read §0 first; it tells an AI reader how to use the repo.

**Written by:** Abdullah Younas (AI engine).
**Status of this file:** the single source of truth for *who owns what*, *what the engine stood in for*, and
*what the backend has to build, with the exact shapes and responses the engine expects*. If this file and the
code disagree, **the code wins** — fix this file in the same change (same rule as `CLAUDE.md`).

---

## 0. How to read this (for an AI assistant)

1. Read `CLAUDE.md` in the repo root — the engine's handover. §4 (who owns what), §6.11 (the AI never mutates
   tenant data), §6.18 (tenant seam), §6.25 (request-taking) matter most here.
2. Read this file top to bottom. Every backend duty is a numbered block **B1…B12** with the same layout:
   *What · Why it is the backend's · What the engine has today (stand-in) · What the backend must provide ·
   Expected responses · What changes in the engine when it arrives.*
3. Everything the engine fakes lives behind **`src/lib/standins/`** (customers, records, events) and the two
   seams **`src/lib/tenant/config.js`** (what has this business configured?) and
   **`src/lib/tenant/registry.js`** (may this tenant be served?). Replacing a stand-in = replacing that file;
   engine code never touches those tables directly.
4. Useful commands (Node 20+, Postgres 16 + pgvector): `npm test` (unit, no DB), `npm run test:collect`
   (request-taking end to end on a real DB with faked models), `npm run db:check`, `npm run dev`
   (console at `:3000`), `npm run voice` (voice gateway at `:3001`).
5. **Vocabulary.** *Tenant* = one business. *Engine* = this repo (`ai_engine` schema). *Backend* = the
   partner platform (`tenant_core` schema). *Request* = an appointment or call-back the agent took
   (stored as a `Record`). *Console* = the test UI in `src/app/page.js` — **not** the product dashboard.

---

## 1. Ownership at a glance

| Area | Engine (Abdullah) | Backend (Haseeb) |
| --- | --- | --- |
| Tenants, users, login, roles, onboarding | — | **owns** (B1) |
| Plans, billing, quotas, suspension | enforces via one function | **owns** (B1, B8) |
| Agent settings (name, tone, hours, language, voices…) | reads, uses in the prompt | **stores, versions, edits via dashboard** (B2) |
| "What the agent collects" settings | defines the catalogue + validates | **stores the document** (B3) |
| Customers and requests (appointments, call-backs), staff screen, status workflow | proposes / saves / corrects while `requested` | **owns the data and the workflow** (B4) |
| Knowledge files: upload UI, **file storage (Cloudinary)**, limits, document list | reads, splits, embeds, searches | **owns storage, limits, UI** (B5) |
| Integration secrets (Gemini, Groq, Cloudinary, Twilio…) | consumes | **stores, hands to engine** (B6) |
| Events engine → backend (outbox) | produces | **receives** (B7) |
| Usage metering (minutes, messages, requests) | reports events | **counts, bills** (B8) |
| Customer notifications (WhatsApp / SMS) | emits the event | **sends** (B9) — decision needed |
| Calendar / slot availability | asks (future) | **owns** (B10) |
| Phone numbers, Twilio provisioning, number→tenant mapping | call handling | **owns purchase + mapping** (B11) |
| Dashboard UI + its translations | provides labels + catalogue | **builds the real dashboard** (B12) |
| RAG (extract, OCR, chunk, embed, retrieve), the brain, prompts | **owns** | — |
| Request-taking state machine, validation, extraction | **owns** | — |
| Voice gateway, STT/TTS, barge-in, call logs and turns, conversation storage | **owns** | reads for billing if wanted |

**Hard rules that never change** (from `CLAUDE.md`):
- **The AI never books, confirms or cancels anything on its own authority.** It saves a request as `requested`;
  a person confirms. (It may withdraw/correct *its own customer's* request while still `requested`.)
- `tenantId` is an **opaque string** `^[A-Za-z0-9_-]{1,100}$`; every engine query is scoped by it.
- The engine **never creates or migrates `tenant_core` tables.**
- Only **English (`en`) and Urdu (`ur`)** exist — UI and agent. Do not send `it`, `ar` or `auto`.

---

## 2. The product flow (so the duties make sense)

```
Business owner ──(dashboard, B12)──▶ Backend stores settings (B2/B3) + knowledge files (B5)
                                         │ engine reads settings / processes files
Customer (phone / chat) ──▶ ENGINE: understand → search knowledge → answer, in en or ur
                                         │ customer wants an appointment / call-back
                          ENGINE: asks the owner's checklist, validates each answer,
                                  SAVES the request the moment every required detail is in (status "requested"),
                                  reads it back, applies corrections to the same row
                                         │
Backend (B4/B7) ◀── request + events ── staff see it in the dashboard, confirm / reject / complete
Backend (B9) ──▶ tells the customer (WhatsApp/SMS) · Backend (B8) ──▶ counts usage, bills
```

---

## 3. What the backend must build

Conventions for all shapes below: JSON, UTF-8, ids are strings, timestamps ISO-8601 UTC, auth between the two
sides is the shared **`x-internal-key`** header today (`src/lib/auth/internal.js` — fails closed in production).
Engine errors are `{ "error": "<message translated into the reader's locale>" }` with a normal HTTP status.

### B1 — Tenants, authentication, serviceability

- **What:** tenant accounts, users, roles, login, onboarding, suspension, plan and quota checks.
- **Why backend:** it is the platform; the engine only consumes `tenantId`.
- **Engine today:** every syntactically valid `tenantId` is served. All routes call
  `requireServiceableTenant()` → `assertTenantServiceable(tenantId)` in `src/lib/tenant/registry.js`
  (also enforces the id shape). The console passes `tenantId` as a query parameter.
- **Backend provides:** a lookup the engine can call, cached ~60 s:
  `GET /internal/tenants/{tenantId}/status` →
  ```json
  { "tenantId": "t_123", "serviceable": true, "reason": null, "plan": "pro" }
  ```
  When not serviceable: `serviceable:false`, `reason` ∈ `suspended | unpaid | quota_exceeded | unknown_tenant`.
- **Engine expects:** non-serviceable → engine answers its own caller with HTTP `403` (suspended/unpaid),
  `429` (quota), `404` (unknown tenant) and a translated message.
- **Engine change:** edit **only** `assertTenantServiceable()`. No route changes.

### B2 — Versioned agent settings

- **What:** the settings a business edits in the dashboard, with history/versioning.
- **Why backend:** his responsibility table — "versioned agent config".
- **Engine today:** table `ai_engine.agent_configs` (one row per tenant), read through
  `getAgentConfig(tenantId)` in `src/lib/tenant/config.js` (60 s in-process cache), written by
  `PUT /api/agent-config`.
- **Fields (the contract):**

  | Field | Type / values | Meaning |
  | --- | --- | --- |
  | `businessName` | string ≤120 | spoken name; placeholder `"this business"` until set |
  | `purpose` | string ≤2000 | what the business does, in its words (answers "who are you?") |
  | `tone` | `professional \| friendly \| concise \| formal` | |
  | `timezone` | IANA name, e.g. `Asia/Karachi` | used for hours and bookings |
  | `uiLocale` | `en \| ur` | dashboard language (Urdu renders right-to-left) |
  | `replyLanguage` | `en \| ur` | what the agent *says*; it always *understands* both |
  | `hours` | `{ "mon": [["09:00","17:00"]], … "sun": [] }` | opening hours in `timezone` |
  | `escalation` | `{ email, phone, whenUserAsks, whenAgentUnsure }` or null | hand-off to a human |
  | `capabilities` | `{ "<capabilityId>": { enabled, channels, params } }` | catalogue: `GET /api/agent-config/catalog` |
  | `voices` | `{ "en": "kokoro:af_heart", "ur": "kokoro:hf_alpha" }` | ids from `src/lib/voice/speech/voices.js` |
  | `collect`, `collectVersion` | see B3 | |

- **Backend provides:** store the document; make it readable by the engine:
  `GET /internal/tenants/{tenantId}/agent-config` → `{ "config": { …fields above… }, "version": 12 }`.
  Writes come from the dashboard, validated by the rules in `src/app/api/agent-config/route.js`
  (the engine keeps the validation code and can expose it as `POST /api/agent-config/validate` — say if wanted).
- **Responses the engine gives today** (`/api/agent-config`): `GET → { config, locale }`;
  `PUT → { config }` or `400 { error }` with all problems translated.
- **Engine change:** make `getAgentConfig()` fetch from the backend (cache stays); `saveAgentConfig()` goes away.

### B3 — "What the agent collects" settings

- **What:** which details the agent asks for (name, phone, service, date-time, party size, reason…), per request
  type (`appointment`, `callback`), the business's own **services** and **staff** lists, custom fields, order,
  required/optional, optional custom wording (en + ur).
- **Why backend:** it is part of the versioned config the dashboard edits.
- **Engine owns:** the **catalogue** (all possible fields, request types, industry presets, limits, and the
  validation of a saved document) in `src/lib/collect/catalog.js` / `config.js`. The backend must **not**
  hard-code field names; it draws the checklist from the engine's catalogue.
- **Engine API today:** `GET /api/collect?tenantId=…` → `{ collect, version, catalog, locale }`;
  `PUT /api/collect?tenantId=…` body `{ "collect": {…} }` → `{ collect, version }` (whole document replaced,
  `version` +1) or `400 { error }` (e.g. "a request type must be able to reach the customer").
- **Document shape:**
  ```jsonc
  { "enabled": true,                       // MASTER SWITCH — off ⇒ agent only chats, saves nothing
    "industry": "dental",                  // starting preset, informational
    "services": [{ "id": "root_canal", "label": { "en": "Root canal", "ur": "روٹ کینال" } }],
    "staff":    [{ "id": "dr_ali", "label": { "en": "Dr Ali", "ur": "ڈاکٹر علی" } }],
    "customFields": [{ "id": "c_parking", "type": "yesno", "label": {…}, "question": {…}, "sensitive": false }],
    "recordTypes": {
      "appointment": { "enabled": true, "fields": [ { "id":"name","required":true }, { "id":"phone","required":true }, { "id":"service","required":true }, { "id":"datetime","required":true }, { "id":"notes","required":false } ] },
      "callback":    { "enabled": true, "fields": [ … ] } } }
  ```
  Limits: ≤12 fields per type, ≤10 custom fields, ≤60 service/staff entries, ≤30 options per custom choice.
- **Backend provides:** persistence + dashboard UI (checklist). Engine reads it with the config in B2.
- **Engine change:** `saveCollectConfig()` becomes a pass-through; validation stays in the engine.

### B4 — Customers and requests (the staff workflow)

- **What:** the end-customer directory and the requests the agent takes, plus the staff screen.
- **Why backend:** business data and the staff dashboard; per the responsibility table the engine "proposes".
- **Engine today (stand-in, `src/lib/standins/`):** tables `ai_engine.customers`
  (unique `(tenant_id, phone)`) and `ai_engine.records`; functions `upsertCustomer`, `createRecord`,
  `updateRecordDetails`, `withdrawRecord`, `listRecords`, `getRecord`, `updateRecordStatus`;
  console routes `GET /api/records`, `GET|PATCH /api/records/:id` and the "Collected" tab.
- **A request (what the backend stores / receives):**
  ```jsonc
  { "id": "…", "tenantId": "…", "reference": "AP-4K7Q2",      // AP- appointment, CB- call-back; read to the customer
    "type": "appointment",                                       // appointment | callback
    "status": "requested",                                       // requested | confirmed | done | cancelled
    "channel": "voice",                                          // chat | voice (whatsapp later)
    "language": "ur",                                            // language the customer was served in
    "data": { "name": "…", "phone": "+923001234567", "service": "root_canal", "datetime": "2026-10-22T17:00" },
    "summary": "Ahmed · Root canal · Thursday, 22 October 2026 at 5:00 pm",
    "scheduledLocal": "2026-10-22T17:00",   // business wall-clock STRING on purpose; turning it into an instant is the backend's call
    "timezone": "Asia/Karachi", "configVersion": 7, "conversationId": "…", "submissionKey": "…", "createdAt": "…" }
  ```
  Values are already validated: phone in international form, a choice = the owner's option id, `datetime` inside
  opening hours.
- **Rules the backend MUST keep:**
  1. **Idempotent create on `(tenantId, submissionKey)`** — same key ⇒ same record, same `reference`, `200` not `201`.
  2. **Status workflow:** `requested → confirmed | cancelled`, `confirmed → done | cancelled | requested`,
     `done → confirmed`, `cancelled → requested`. Conditional update on the status you read.
  3. **The engine may change a record only while `status = requested`:** it updates `data/summary/scheduledLocal`
     (customer corrected a detail, or answered an optional question) or sets `cancelled` (customer said
     "cancel it"). After a person confirmed, the engine's update is refused with `409 locked` and the customer is
     told a team member will adjust it.
  4. `reference` unique per tenant; avoid look-alike characters (the engine's alphabet has no 0/O/1/I/L).
- **Backend provides (engine → backend):**
  - `POST /internal/records` body = the request above (no `id/status/createdAt`) →
    `201 { "id": "…", "reference": "AP-4K7Q2", "created": true }`, or `200 {… "created": false}` for a repeat key.
  - `PATCH /internal/records/{id}` body `{ "data": {…}, "summary": "…", "scheduledLocal": "…" }` →
    `200 { "ok": true }` or `409 { "error": "locked" }`.
  - `POST /internal/records/{id}/withdraw` → `200 { "ok": true }` or `409 { "error": "locked" }`.
  - `PUT /internal/customers/by-phone/{phone}` body `{ name, email }` → `{ "id": "…" }`.
- **Engine change:** the three functions in `standins/records.js` and `upsertCustomer` call those endpoints; the
  `/api/records*` console routes and the Collected tab are deleted.

### B5 — Knowledge: uploads, file storage (Cloudinary), limits, document list

- **What:** everything a business gives its agent to answer from — typed text, uploaded PDF/DOCX/TXT/MD/CSV,
  a website to crawl — plus keeping the *original* uploaded file.
- **Why backend:** his table — "knowledge uploads/limits". The engine *processes*; it should not own the
  storage account, plan limits or the management UI.
- **Engine today:**
  - **File storage = Cloudinary** (`src/lib/agent/storage.js`, `resource_type: raw`, folder
    `caller-ai-agent/{tenantId}`), best-effort, original file only — **never what the agent answers from**.
    Env: `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` (all three or none; without them uploads still work, the
    original just isn't kept).
  - Limits in code: **10 MB per file** (`MAX_UPLOAD_BYTES`), types `pdf docx txt md csv`, **≤20 files per
    request**, **≤400 chunks per document**.
  - Routes (console): `GET|POST /api/knowledge`, `GET|PUT|DELETE /api/knowledge/:id`,
    `POST /api/knowledge/:id/retry`, `GET /api/knowledge/jobs`, `GET|DELETE /api/knowledge/jobs/:id`
    (cancel), `GET|POST /api/knowledge/search` (debug).
- **What the engine keeps (not the backend's):** text extraction, OCR (scanned PDFs, English+Urdu), heading-aware
  chunking, embeddings (Gemini, 768-d), vector+keyword retrieval, the background job queue and progress.
  A document is **replaced, never appended** (same title ⇒ overwrite and re-embed only changed chunks).
- **Backend provides:** the upload UI, plan limits, and the **file storage**. Two workable splits — pick one:
  - **(A) Backend stores, engine processes (recommended).** Backend accepts the file, stores the original
    (its own Cloudinary account), then calls the engine to ingest:
    `POST /api/knowledge?tenantId=…` multipart `file` (repeatable) **or** `{ "title","text" }` **or** `{ "url" }`.
    Responses today: files/URL → `202 { "jobs": [{ "id","title" }], "rejected": [{ "title","reason" }] }`
    (`400` if every file was rejected); typed text → `201|200 { "document": {…, "replaced": bool } }`.
    The backend then polls `GET /api/knowledge/jobs/:id` → `{ "job": { id, status: queued|processing|done|failed|cancelled,
    stage: extracting|ocr|chunking|embedding, progress: 0-100, itemsDone, itemsTotal, error } }`.
  - **(B) Engine keeps Cloudinary** (today). Backend only supplies Cloudinary credentials (B6). Simpler, but the
    storage and its cost sit outside the platform.
- **Document list the dashboard needs:** `GET /api/knowledge?tenantId=…` →
  `{ "sources": [{ id, title, kind: text|file|url, status: processing|ready|failed, error, fileName, mimeType,
  byteSize, chunkCount, createdAt, updatedAt, editable }], "limits": { maxBytes, extensions } }`.
  (The original file's Cloudinary URL is stored on the row but is not returned by the list; ask if the dashboard needs a download link.) `editable` is decided by the engine (only typed text, `.txt`, `.md`) — the UI must not re-implement it.
- **Expected errors:** `400` bad body/too many files, `409` editing a non-editable document, `404` unknown
  document, `403/429` tenant not serviceable (B1).
- **Engine change (option A):** delete `storage.js` usage for uploads and the console UI; keep ingest/job code.

### B6 — Integration secrets

- **What:** API keys and credentials per environment (and later per tenant): Gemini (chat + embeddings, required),
  Groq (fast chat + Urdu speech recognition), OpenRouter (optional), Cloudinary (B5), Twilio (B11),
  `INTERNAL_API_KEY`, `VOICE_SESSION_SECRET`.
- **Engine today:** read from environment variables (`.env`, documented in `CLAUDE.md` §10).
- **Backend provides:** a secure store and a way to hand secrets to the engine at start-up (env injection is
  fine) — secrets must never be returned by any API, logged, or stored in `agent_configs`.
- **Open decision:** platform-wide keys (simplest) vs. per-tenant keys. The engine today assumes platform-wide.

### B7 — Events: engine → backend (outbox)

- **What:** the engine tells the backend when something happened.
- **Engine today (stand-in, `standins/events.js`):** in-process listeners only — nothing leaves the process.
  Every call site already builds the final envelope `{ "id": "<uuid>", "type", "tenantId", "occurredAt", "data" }`.
- **Events emitted now:**
  | type | data |
  | --- | --- |
  | `record.submitted` | `{ recordId, recordType, reference, conversationId }` |
  | `record.updated` | `{ recordId, status, detailsChanged? }` |
  Event data carries **ids and references, not the customer's details** — read them from the record.
  *Open question:* do you want the details inside the event instead?
- **Backend provides:** `POST /internal/events` that verifies an **HMAC signature** (shared secret, B6) and is
  idempotent on `id`; reply `200 {"received":true}` (any non-2xx ⇒ engine retries with backoff).
- **Engine change:** replace the body of `emitEngineEvent()` with a **database outbox + signed sender**; call sites
  stay the same. (This is also what the voice gateway, a separate process, needs.)

### B8 — Usage metering, plans and quotas

- **What:** counting what a tenant consumes and enforcing plan limits.
- **Engine today:** **nothing is metered.** Only abuse protection exists: chat 60 msgs/min/tenant and 5 per
  10 s per conversation, 10 voice sessions/min/tenant, 3 concurrent calls per tenant — in-process, not billing.
- **Data the engine already has:** `call_logs` (start/end, duration, turns, transport), `call_turns`,
  `messages` (chat), `records`, `ingest_jobs` / embedding counts.
- **Needs agreeing (do this early — retrofitting is painful):** the usage-event shape. Proposal:
  `usage.call_minutes { conversationId, seconds, channel }`, `usage.chat_message { conversationId }`,
  `usage.record_created { recordId }`, `usage.embedding_texts { count }`, delivered through the B7 outbox.
- **Backend provides:** counters, plan limits, billing; and the verdict through B1 (`quota_exceeded`).

### B9 — Telling the customer (WhatsApp / SMS)

- **What:** a confirmation message to the customer's phone when staff confirm a request.
- **Engine today:** not built. The record carries the customer's `phone` and `channel`.
- **Decision needed:** *who sends?* Recommended: **the backend**, triggered by its own `confirmed` transition
  (it already holds the number, the provider account and the billing). The engine only supplies the data.

### B10 — Calendar / slot availability

- **What:** "is Thursday 5 pm actually free?" and booking real slots.
- **Engine today:** checks **opening hours only**; a request is a *wish* the team confirms.
- **Backend provides (when ready):** `GET /internal/tenants/{id}/availability?service=…&date=…` →
  `{ "slots": ["2026-10-22T17:00", …] }`. The engine would offer slots to the caller instead of free-form times.
  Until then nothing changes.

### B11 — Phone numbers and Twilio

- **What:** buying/porting numbers, mapping the **dialled number → tenant**, billing for it.
- **Engine today:** voice works from the browser only. The call logger already has `from_number/to_number`.
- **Backend provides:** number purchase flow and the mapping table; and a lookup the engine's webhook uses:
  `GET /internal/numbers/{e164}` → `{ "tenantId": "…" }` (after the engine verifies the Twilio **webhook
  signature** — the tenant is never taken from anything the caller supplies).
- **Engine builds (later):** the Twilio transport (μ-law 8 kHz ⇄ 16 kHz PCM, barge-in, call setup).

### B12 — The dashboard and its translations

- **What:** the real product UI for business owners.
- **Engine today:** a **test console** (`src/app/page.js`, `src/app/collect/`, `src/app/voice/`) — tabs Agent,
  Knowledge, What it collects, Call, Test chat. It exists to exercise the engine; it is not the product UI and
  will be deleted/reduced when the dashboard exists.
- **Engine provides to the dashboard:**
  - `GET /api/locales` (list) and `GET /api/locales?locale=ur[&ns=dashboard,common]` — every UI string in
    English or Urdu (public, no auth; Urdu is RTL — use logical CSS).
  - `GET /api/agent-config/catalog` — capability list, translated.
  - `GET /api/collect` → `catalog` — fields / request types / industry presets, translated.
  - Voice previews: `GET {gateway}/voices/preview?voice=…`; voice list in the gateway's `/health`.
- **Backend builds:** the screens for B2–B5, a "calls" history reading `call_logs` if wanted, and the staff
  request screen (B4).

---

## 4. Engine API surface today (what exists right now)

All routes: server-to-server, header `x-internal-key`, `?tenantId=` required (except `/api/locales`).
Mutating routes also pass the B1 gate. Errors: `{ "error": string }`.

| Route | Purpose | Success |
| --- | --- | --- |
| `GET/PUT /api/agent-config` | read / patch agent settings (B2) | `{config,locale}` / `{config}` |
| `GET /api/agent-config/catalog` | capability catalogue | `{locale,capabilities}` |
| `GET/PUT /api/collect` | collect settings + catalogue (B3) | `{collect,version,catalog,locale}` |
| `GET /api/records`, `GET/PATCH /api/records/:id` | requests (B4) — console only | `{data,total,counts}` / row |
| `GET/POST /api/knowledge`, `…/:id`, `…/:id/retry`, `…/jobs*`, `…/search` | knowledge (B5) | see B5 |
| `POST /api/chat` | test chat, **SSE**: `session`, `chunk`, `done`, `error` | `done` = `{reply,model,sources,collection,…}` |
| `POST /api/voice/session` | one-minute single-use ticket for the voice WebSocket | `{ticket,url,healthUrl,expiresAt}` |
| `GET /api/voice/calls`, `/api/voice/calls/:id` | call history (turns, timeline) | list / detail |
| `GET /api/locales` | UI strings (public) | catalog |

Voice gateway (separate process, `npm run voice`, port 3001): `GET /health`, `GET /voices/preview`,
WebSocket `/call?ticket=…`.

**Not built — the contract routes from your OpenAPI files** (`engine-internal`, `backend-events`):
the `/internal/*` surface, the streaming (SSE) conversation protocol, conversation claim/release, and the
delivery outbox. They are not in this repo. Tell me which come first and I will build them against the
stand-in interfaces above; the shapes in §3 are my proposal and yours to correct.

---

## 5. My side (engine) — done and to do

**Done and working** (tests: `npm test` 446, `npm run test:collect`, `db:check`, lint, build all green):
- English + Urdu everywhere (UI, replies, voices, speech recognition); agent understands both, answers in the chosen one.
- RAG: extraction (PDF/DOCX/TXT/MD/CSV, OCR), chunking, Gemini embeddings, hybrid search, replace-not-append,
  background jobs, cancellation, retry.
- Request-taking: configurable checklist, state machine, validation, **save-on-completion**, read-back, correction
  of the same row, withdraw, idempotency (`submissionKey`), draft expiry (30 min).
- Voice from the browser: local STT/TTS (+ Groq Whisper for Urdu), barge-in, full call logging.
- Test console (`page.js`) and the stand-ins (`src/lib/standins/`).

**To do on my side:**
1. Build the `/internal/*` contract routes you choose, and replace the stand-ins as each backend piece lands.
2. Real outbox + signed event sender (B7).
3. Usage events (B8) once the shape is agreed.
4. Twilio transport + webhook (B11), compliance wording (recording consent, calling hours).
5. Fix: an utterance cut by a pause arrives as two turns; agent memory after a long pause.
6. Measure Urdu retrieval/answers (the eval baseline predates the language change) and tune latency.
7. Later: speech models on a server and a paid LLM key (infrastructure, not code).

**Decisions I need from you:** the B5 split (A or B); who sends WhatsApp/SMS (B9); platform-wide vs per-tenant
keys (B6); whether events carry customer details (B7); the usage-event shape (B8); which `/internal` routes first.

---

## 6. Migration note

Engine migrations are hand-written where needed because Prisma would emit a `DROP INDEX` for the HNSW
similarity index (`CLAUDE.md` §6.1). Latest: `20261020100000_two_languages_and_collect` — adds
`agent_configs.collect` / `collect_version`, `conversations.collect_draft`, the `customers` and `records`
tables, and relabels any Italian/`auto` leftovers (reply/UI language → `en`). After applying any migration:
`npx prisma generate`, restart `npm run dev` **and** `npm run voice` (the gateway keeps its own Prisma client and
a 60 s settings cache), then `npm run db:check`.
