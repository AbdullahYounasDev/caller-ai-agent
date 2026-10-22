# Engine ⇄ Backend hand-off

**Audience:** Abdul Haseeb (backend / multi-tenant platform) — and any AI assistant given this document
together with this repository. Read §0 first; it tells an AI reader how to use the repo.

**Written by:** Abdullah Younas (AI engine).
**Status of this file:** the single source of truth for *who owns what*, *what the engine stood in for*, and
*what the backend has to build, with the exact shapes and responses the engine expects*. If this file and the
code disagree, **the code wins** — fix this file in the same change (same rule as `CLAUDE.md`).

---

## 0. How to read this (for an AI assistant)

1. Read `CLAUDE.md` in the repo root — the engine's handover. §4 (who owns what, and every stand-in with the seam it
   is read through), §6.11 (the AI never mutates tenant data), §6.18 (tenant seam), §6.25 (request-taking), §6.27
   (agents), §6.28 (knowledge per agent) and §6.29 (phone numbers) matter most here.
2. Read this file top to bottom. Every backend duty is a numbered block **B1…B12** with the same layout:
   *What · Why it is the backend's · What the engine has today (stand-in) · What the backend must provide ·
   Expected responses · What changes in the engine when it arrives.*
3. Everything the engine stands in for today is read through ONE seam each, so replacing it = changing that file:
   **`src/lib/tenant/config.js`** (agents and their settings), **`src/lib/agent/knowledge-access.js`** (which agents
   use each document), **`src/lib/tenant/registry.js`** (may this tenant be served? which agent does this phone
   number ring?) and **`src/lib/standins/`** (customers, requests, events, phone numbers). Engine code never touches
   those tables directly. The engine routes that WRITE them (`/api/agents`, `/api/agent-config`, `/api/collect`,
   `/api/numbers`, the `agents` field of `/api/knowledge`) are a stand-in dashboard — they show the shapes your side
   needs and go away when it exists.
4. Useful commands (Node 20+, Postgres 16 + pgvector): `npm test` (unit, no DB), `npm run test:collect`
   (request-taking end to end on a real DB with faked models), `npm run test:agents` (agents, knowledge per agent,
   every setting per agent), `npm run test:numbers` (the phone-number lookup), `npm run db:check`, `npm run dev`
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
| **Agents** (a tenant has one or more) and each agent's settings (name, tone, hours, language, voices, forwarding…) | reads, uses in the prompt and on calls | **creates/archives agents; stores, versions, edits settings via dashboard** (B2) |
| "What the agent collects" settings | defines the catalogue + validates | **stores the document** (B3) |
| Customers and requests (appointments, call-backs), staff screen, status workflow | proposes / saves / corrects while `requested` | **owns the data and the workflow** (B4) |
| Knowledge files: upload UI, **original-file storage (Cloudinary or other)**, limits, document list, **which agents use each document** | receives the file/text, extracts, splits, embeds, searches only what the agent may use; keeps extracted text only | **owns the original file, storage, limits, UI, the per-document agent list** (B5) |
| Integration secrets | **keeps its own AI keys** (Gemini, Groq…) in its deployment | **keeps its own** (storage, billing, WhatsApp/SMS, Twilio account); only `INTERNAL_API_KEY` + event-signing secret are shared (B6) |
| Events engine → backend (outbox) | produces | **receives** (B7) |
| Usage metering (minutes, messages, requests) | reports events | **counts, bills** (B8) |
| Customer notifications (WhatsApp / SMS) | emits the event | **sends** (B9) — decision needed |
| Calendar / slot availability | asks (future) | **owns** (B10) |
| Phone numbers, Twilio provisioning, **number → agent** mapping | the lookup on every call + call handling | **owns purchase, release, billing and the mapping** (B11) |
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

### B2 — Versioned agent settings (one document per AGENT)

- **What:** the settings a business edits in the dashboard, with history/versioning.
- **Why backend:** his responsibility table — "versioned agent config".
- **A tenant has one or more AGENTS** (CLAUDE.md §6.27): a restaurant chain one per branch, a call centre one per
  line or client. The AI engine is the one brain; an agent is one *setup* it answers with. Each agent has its own
  copy of every field below. One agent per tenant is the **default**: it answers anything that names no agent, so a
  tenant with one agent never sees the difference. Agents are **archived, never deleted** (calls and requests point
  at them); the default cannot be archived. Knowledge is one library per tenant; each document is shared by every
  agent or limited to some (B5).
- **Engine today:** table `ai_engine.agent_configs` (one row per agent; `default_for = tenant_id` marks the default),
  read through `getAgentConfig(tenantId, { agentId })` in `src/lib/tenant/config.js` (60 s in-process cache),
  written by `PUT /api/agent-config?agentId=…`; agents managed through `/api/agents` (below).
- **Agent identity fields:** `agentId` (uuid), `name` (≤60, unique among the tenant's active agents; may be empty on
  the default), `status` (`active | archived`), `isDefault`.
- **Fields (the contract) — per agent, except `uiLocale`, which is per tenant:**

  | Field | Type / values | Meaning |
  | --- | --- | --- |
  | `businessName` | string ≤120 | spoken name; placeholder `"this business"` until set |
  | `purpose` | string ≤2000 | what the business does, in its words (answers "who are you?") |
  | `tone` | `professional \| friendly \| concise \| formal` | |
  | `timezone` | IANA name, e.g. `Asia/Karachi` | used for hours and bookings |
  | `uiLocale` | `en \| ur` | dashboard language (Urdu renders right-to-left) — **the tenant's**, whichever agent is saved |
  | `replyLanguage` | `en \| ur` | what the agent *says*; it always *understands* both |
  | `hours` | `{ "mon": [["09:00","17:00"]], … "sun": [] }` | opening hours in `timezone` |
  | `escalation` | `{ enabled, contacts: [{id, role, name, phone}], whenCallerAsks, afterMisses 1–4, topics[], outsideHours: "callback"\|"forward" }` | **call forwarding** to a person (CLAUDE.md §6.26). Validated by the engine (`validation:handoff.*`); phones stored as `+92…`. The backend stores the document; the engine reads it |
  | `capabilities` | `{ "<capabilityId>": { enabled, channels, params } }` | catalogue: `GET /api/agent-config/catalog` |
  | `voices` | `{ "en": "kokoro:af_heart", "ur": "kokoro:hf_alpha" }` | ids from `src/lib/voice/speech/voices.js` |
  | `collect`, `collectVersion` | see B3 | |

- **Backend provides:** store one document per agent; make them readable by the engine:
  `GET /internal/tenants/{tenantId}/agents` → `{ "agents": [{ agentId, name, status, isDefault }] }` and
  `GET /internal/tenants/{tenantId}/agents/{agentId}/config` → `{ "config": { …fields above… }, "version": 12 }`
  (no `agentId` ⇒ the default agent's). **Plan limits** ("your plan includes 3 agents") are yours: the engine asks
  through one hook, `assertCanAddAgent()` in `src/lib/tenant/registry.js` (today: always allowed, with an engine
  safety cap of 25 active agents).
  Writes come from the dashboard, validated by the rules in `src/app/api/agent-config/route.js`
  (the engine keeps the validation code and can expose it as `POST /api/agent-config/validate` — say if wanted).
- **Responses the engine gives today** (`/api/agent-config?agentId=`): `GET → { config, locale }`;
  `PUT → { config }` or `400 { error }` with all problems translated; `404` for an agent that is not this tenant's.
  Agents: `GET /api/agents` → `{ agents }` (default first; a tenant that saved nothing shows its default with
  `id: null`); `POST /api/agents { name, copyFrom? }` → `201 { agent }` (starts as a copy of another agent's
  settings); `PATCH /api/agents/:id { name?, status?, makeDefault? }` → `{ agent }`.
- **Engine change:** make `getAgentConfig()` / `listAgents()` fetch from the backend (cache stays);
  `saveAgentConfig()`, `createAgent()`, `updateAgent()` go away.

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
    original just isn't kept). It was added for the test console; under the decided split below it is not needed.
  - Limits in code: **10 MB per file** (`MAX_UPLOAD_BYTES`), types `pdf docx txt md csv`, **≤20 files per
    request**, **≤400 chunks per document**.
  - **Which agents use a document** (CLAUDE.md §6.28): shared (every agent of the tenant — the default) or limited to
    chosen agents. Table `ai_engine.knowledge_source_agents (source_id, agent_id, tenant_id)`; no row = shared. Every
    knowledge route returns `agents` per document (`null` = shared) and takes `agents` (`"all"` | `null` | `[agentId…]`)
    on create/replace/edit; changing it alone re-embeds nothing. When the backend owns the document list, it stores
    this list next to each document and the engine reads it the same way it reads the text.
  - Routes (console): `GET|POST /api/knowledge`, `GET|PUT|DELETE /api/knowledge/:id`,
    `POST /api/knowledge/:id/retry`, `GET /api/knowledge/jobs`, `GET|DELETE /api/knowledge/jobs/:id`
    (cancel), `GET|POST /api/knowledge/search` (debug).
- **What the engine keeps (not the backend's):** text extraction, OCR (scanned PDFs, English+Urdu), heading-aware
  chunking, embeddings (Gemini, 768-d), vector+keyword retrieval, the background job queue and progress.
  A document is **replaced, never appended** (same title ⇒ overwrite and re-embed only changed chunks).
- **DECIDED SPLIT — the backend stores the original file; the engine only processes it.**
  1. **Cloudinary (or any file storage) is the backend's.** The backend keeps the original uploaded file in
     **its own** storage account, with its own limits and cost. The **engine does not need Cloudinary and the
     backend does not need to give it Cloudinary credentials** — see B6.
  2. **The engine keeps only what it answers from:** the extracted text and its embeddings (rows in
     `knowledge_sources` / `knowledge_chunks`). It never needs the original file again, and re-chunking works
     from the stored text.
  3. **Flow:** owner uploads in the dashboard → backend checks plan limits, stores the original → backend calls the
     engine to ingest:
     `POST /api/knowledge?tenantId=…` multipart `file` (repeatable) **or** `{ "title","text" }` **or** `{ "url" }`.
     Responses today: files/URL → `202 { "jobs": [{ "id","title" }], "rejected": [{ "title","reason" }] }`
     (`400` if every file was rejected); typed text → `201|200 { "document": {…, "replaced": bool } }`.
     The backend then follows progress with `GET /api/knowledge/jobs/:id` →
     `{ "job": { id, status: queued|processing|done|failed|cancelled, stage: extracting|ocr|chunking|embedding,
     progress: 0-100, itemsDone, itemsTotal, error } }`.
  4. **Replace and delete:** a document with an existing title is **replaced** (never appended);
     `DELETE /api/knowledge/:id` removes the text and chunks. The backend deletes its own stored original at the
     same time.
  5. **TODAY (no change needed for now):** the engine's code still uploads a copy to Cloudinary **if** the three
     `CLOUDINARY_*` variables are set, and skips it silently if they are not. **Leave them unset in the deployed
     engine.** Nothing breaks: uploads, search and answers work exactly the same without them. The Cloudinary
     code stays in the repo for now and is removed later, when the backend's storage is live.
- **Document list the dashboard needs:** `GET /api/knowledge?tenantId=…` →
  `{ "sources": [{ id, title, kind: text|file|url, status: processing|ready|failed, error, fileName, mimeType,
  byteSize, chunkCount, createdAt, updatedAt, editable }], "limits": { maxBytes, extensions } }`.
  (The original file's Cloudinary URL is stored on the row but is not returned by the list; ask if the dashboard needs a download link.) `editable` is decided by the engine (only typed text, `.txt`, `.md`) — the UI must not re-implement it.
- **Expected errors:** `400` bad body/too many files, `409` editing a non-editable document, `404` unknown
  document, `403/429` tenant not serviceable (B1).
- **Engine change later:** remove the optional `storage.js` upload and the console UI; keep the ingest/job code. Not needed to go live.

### B6 — Integration secrets

**DECIDED APPROACH (for now): each side keeps its own secrets; the engine's secrets stay inside the engine's
deployment.** Nothing is passed between the systems, and no secret is stored in a database table or returned by an
API. We revisit this only if a concrete need appears (for example businesses bringing their own accounts).

- **Engine secrets — set on the engine's deployment** (environment variables or the host's secret manager; never in
  git, never in `agent_configs`). Only what the AI work itself needs:

  | Secret | Used for | Required |
  | --- | --- | --- |
  | `GEMINI_API_KEY` | chat model and **embeddings** (embeddings are Gemini-only) | **yes** |
  | `GROQ_API_KEY` | fast chat model and Urdu speech recognition (Whisper) | for voice / Urdu |
  | `OPENROUTER_API_KEY` | optional fallback chat provider | no |
  | `INTERNAL_API_KEY` | authenticates calls between the backend and the engine | **yes** |
  | `VOICE_SESSION_SECRET` | signs the one-minute voice-call tickets (falls back to `INTERNAL_API_KEY`) | recommended |
  | event-signing secret (B7) | HMAC on engine → backend events | when B7 is built |
  | Twilio webhook signature secret | verifying incoming phone-call webhooks | when B11 is built |

  Provider and model choices (`LLM_PROVIDER`, `GEMINI_CHAT_MODEL`, …) are plain environment settings, listed in
  `CLAUDE.md` §10.
- **Backend secrets — stay on the backend:** file storage / Cloudinary (B5), billing and payment keys, the
  WhatsApp/SMS provider (B9), the Twilio **account** keys used to buy and manage numbers (B11), his own database
  and auth secrets. **The engine does not need any of these.**
- **Shared by both sides — one value, configured on both:** `INTERNAL_API_KEY` and the event-signing secret.
  Agree them out of band and rotate them together.
- **`CLOUDINARY_*` on the engine: leave unset.** The engine works without them (see B5).
- **Rules:** secrets are never logged, never returned by any route, never stored in `agent_configs` or any table a
  dashboard can read.
- **Revisit later (not now):** per-business keys, and whether the backend should inject engine secrets at deploy
  time. The engine today assumes **platform-wide keys paid by the platform**.

### B7 — Events: engine → backend (outbox)

- **What:** the engine tells the backend when something happened.
- **Engine today (stand-in, `standins/events.js`):** in-process listeners only — nothing leaves the process.
  Every call site already builds the final envelope `{ "id": "<uuid>", "type", "tenantId", "occurredAt", "data" }`.
- **Events emitted now:**
  | type | data |
  | --- | --- |
  | `record.submitted` | `{ recordId, recordType, reference, agentId, conversationId }` |
  | `record.updated` | `{ recordId, status, detailsChanged? }` |
  | `handoff.requested` | `{ conversationId, agentId, channel, reason: asked\|topic\|not_understood\|frustrated, contactId }` — a caller was passed to a person |
  | `handoff.unavailable` | `{ conversationId, agentId, channel, reason, contactId: null }` — a person was needed but the business was closed |
  `agentId` = which of the tenant's agents handled it. Conversations, calls (`call_logs.agent_id`) and requests
  (`records.agent_id`) carry it too, so usage and reports can be split per agent (and, with B11, per number).
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
- **Data the engine already has:** `call_logs` (start/end, duration, turns, transport, and which agent and which phone
  number answered — so usage can be billed per agent and per number), `call_turns`,
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

- **What:** buying / porting / releasing numbers, billing for them, and keeping **which agent each number rings** —
  each number rings exactly ONE agent; an agent may have many numbers (a restaurant chain: one per branch; a call
  centre: several lines on one agent). Also the "forwarding number": the hidden number a business forwards its own
  line to, so it keeps the number printed on its menus.
- **Engine today (CLAUDE.md §6.29):**
  - **The lookup is BUILT** — `resolveDialledNumber(dialled)` in `src/lib/tenant/registry.js`: dialled number (E.164)
    → `{ tenantId, agentId, numberId }`, or a refusal with a reason: `invalid_number`, `unknown`, `released`,
    `unassigned` (linked to no agent), `agent_archived`, `tenant_unserviceable`. It never guesses: a refused number
    is never sent to "some" agent and never to another business; the caller hears a polite "not in service" line.
    Cached ~30 s, dropped on every change; serviceability re-checked on every call.
  - **The numbers themselves are a STAND-IN**: table `ai_engine.phone_numbers` behind `src/lib/standins/numbers.js`
    (`id, tenantId, e164, agentId, label, status: active|released, kind: purchased|forwarding, provider, providerSid`).
    Rules kept there because routing depends on them: one ACTIVE number = one business (database-enforced); a number
    rings an ACTIVE agent of its OWN business; an agent that numbers still ring cannot be archived; a released number
    keeps its row (call history) and can be bought again by anyone.
  - Routes (stand-in dashboard): `GET|POST /api/numbers`, `PATCH /api/numbers/:id` (`{ agentId, label, status:
    "released" }`), and `GET /api/numbers/lookup?to=+44…` to try the routing — tenant-agnostic on purpose.
  - Calls record `to_number`, `phone_number_id` and `agent_id` (`call_logs`); `GET /api/voice/calls?numberId=` lists
    one number's calls — the basis for per-number usage and billing (B8).
- **Backend provides:** the number purchase / release / billing flow and the mapping table, and ONE read the engine
  calls on every inbound call:
  `GET /internal/numbers/{e164}` → `200 { "tenantId": "…", "agentId": "…" | null, "numberId": "…", "status": "active" | "released" }`
  or `404` for a number you have never had. The engine applies the rules above to that answer (unlinked → refuse,
  agent archived → refuse, released → refuse). Please refuse at write time what the engine refuses at call time:
  a number without a country code, an agent of another tenant, an archived agent.
- **Engine change when it lands:** `findNumberForRouting()` calls your endpoint instead of the stand-in table;
  `resolveDialledNumber`, its callers and its tests stay. `/api/numbers` and the console's Numbers tab are removed.
- **Engine builds next:** the Twilio webhook (verify Twilio's signature FIRST → this lookup → TwiML
  `<Connect><Stream>` to the voice gateway, or `<Say>` the not-in-service line and hang up) and
  `transports/twilio.js` (μ-law 8 kHz ⇄ 16 kHz PCM, barge-in, the real `transfer`, B11b).
- **Open:** who owns the Twilio account and the purchase API calls (proposal: the backend, since it bills); whether the
  engine also needs `GET /internal/tenants/{id}/numbers` for reports.

### B11b — Passing a call to a person (the transfer seam)

- **What:** the owner lists who a caller may be forwarded to (role, name, phone); the engine decides *when* and tells the
  caller; **placing the transfer** is the phone transport's job.
- **Engine today:** the decision, the announcement, the order of contacts, the fallback when nobody answers, and the
  summary for the person who picks up are all built and tested. The browser console only *simulates* the transfer.
- **What the real phone transport (Twilio, engine side) must implement:**
  `transport.transfer(contact, { summary, reason, callId }) → { connected: boolean, reason?: "busy"|"no_answer"|"failed" }`.
- **What the backend provides:** storing the `escalation` document (B2), and — if it owns Twilio numbers (B11) — the
  caller-id / number to dial out from. The engine never logs or returns the contacts' numbers except to the transport.
- **Events:** `handoff.requested`, `handoff.unavailable` (B7).

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
Mutating routes also pass the B1 gate. Errors: `{ "error": string }`. `?agentId=` is optional everywhere it appears:
without it, the tenant's default agent (settings, chat, calls) or every agent (lists). An archived agent is refused
(`409`) where it would answer a caller (chat, voice).

| Route | Purpose | Success |
| --- | --- | --- |
| `GET/PUT /api/agent-config[?agentId=]` | read / patch one agent's settings (B2) | `{config,locale}` / `{config}` |
| `GET/POST /api/agents`, `PATCH /api/agents/:id` | list / add / rename, archive, make default (B2) | `{agents}` / `{agent}` |
| `GET /api/agent-config/catalog` | capability catalogue | `{locale,capabilities}` |
| `GET/PUT /api/collect[?agentId=]` | one agent's collect settings + catalogue (B3) | `{agentId,collect,version,catalog,locale}` |
| `GET /api/records[?agentId=]`, `GET/PATCH /api/records/:id` | requests (B4) — console only | `{data,total,counts}` / row |
| `GET/POST /api/knowledge[?agentId=]`, `…/:id`, `…/:id/retry`, `…/jobs*`, `…/search` | knowledge (B5) — each document's `agents` (null = shared) | see B5 |
| `POST /api/chat[?agentId=]` | test chat, **SSE**: `session`, `chunk`, `done`, `error` | `done` = `{reply,model,sources,collection,…}` |
| `POST /api/voice/session[?agentId=][&to=+44…]` | one-minute single-use ticket for the voice WebSocket (agent signed in); `to` = call "as if dialling" that number, through the real lookup | `{ticket,agentId,line,url,healthUrl,expiresAt}` |
| `GET /api/voice/calls[?agentId=][&numberId=]`, `/api/voice/calls/:id` | call history (turns, timeline), per agent or per number | list / detail |
| `GET/POST /api/numbers[?agentId=]`, `PATCH /api/numbers/:id` | phone numbers and the agent each rings (B11) — stand-in | `{numbers}` / `{number}` |
| `GET /api/numbers/lookup?to=` | the phone-number lookup (B11), no tenantId | `{ok,tenantId,agentId,numberId,e164}` or `{ok:false,reason}` |
| `GET /api/locales` | UI strings (public) | catalog |

Voice gateway (separate process, `npm run voice`, port 3001): `GET /health`, `GET /voices/preview`,
WebSocket `/call?ticket=…`.

**Not built — the contract routes from your OpenAPI files** (`engine-internal`, `backend-events`):
the `/internal/*` surface, the streaming (SSE) conversation protocol, conversation claim/release, and the
delivery outbox. They are not in this repo. Tell me which come first and I will build them against the
stand-in interfaces above; the shapes in §3 are my proposal and yours to correct.

---

## 5. My side (engine) — done and to do

**Done and working** (tests: `npm test` 567, `npm run test:collect`, `npm run test:agents`, `npm run test:numbers`, `db:check`, lint, build all green):
- English + Urdu everywhere (UI, replies, voices, speech recognition); agent understands both, answers in the chosen one.
- RAG: extraction (PDF/DOCX/TXT/MD/CSV, OCR), chunking, Gemini embeddings, hybrid search, replace-not-append,
  background jobs, cancellation, retry.
- Request-taking: configurable checklist, state machine, validation, **save-on-completion**, read-back, correction
  of the same row, withdraw, idempotency (`submissionKey`), draft expiry (30 min).
- Voice from the browser: local STT/TTS (+ Groq Whisper for Urdu), barge-in, full call logging.
- Test console (`page.js`) and the stand-ins (`src/lib/standins/`).
- Several agents per tenant: each with its own settings, checklist, call forwarding, voice and language; chat, calls
  and requests are stamped with the agent; a default agent keeps single-agent tenants unchanged.
- Knowledge per agent: one library, each document shared or limited to chosen agents; every search is scoped to the
  agent answering.
- The phone-number lookup: dialled number → business → agent, refusing (never guessing) unknown, released, unlinked,
  archived-agent and suspended cases; calls record the number they came in on (B11). The numbers are a stand-in.

**To do on my side:**
1. Build the `/internal/*` contract routes you choose, and replace the stand-ins as each backend piece lands.
2. Real outbox + signed event sender (B7).
3. Usage events (B8) once the shape is agreed.
4. Twilio webhook + transport (B11) on top of the built lookup; compliance wording (AI disclosure, recording consent).
5. Fix: an utterance cut by a pause arrives as two turns; agent memory after a long pause.
6. Measure Urdu retrieval/answers (the eval baseline predates the language change) and tune latency.
7. Later: speech models on a server and a paid LLM key (infrastructure, not code).

**Decided:** (1) the backend stores the original files (Cloudinary or other) — the engine keeps only extracted text
and embeddings, and runs without `CLOUDINARY_*` (B5); (2) secrets stay where they are used — AI keys in the engine's
deployment, storage/billing/messaging/Twilio-account keys on the backend, only `INTERNAL_API_KEY` and the
event-signing secret shared (B6).

**Still open — decisions I need from you:** who sends WhatsApp/SMS (B9); whether events carry customer details (B7);
the usage-event shape (B8); which `/internal` routes come first; who owns the Twilio account and the purchase calls (B11).

---

## 6. Migration note

Engine migrations are hand-written where needed because Prisma would emit a `DROP INDEX` for the HNSW
similarity index (`CLAUDE.md` §6.1). Latest: `20261024100000_phone_numbers` — the stand-in `phone_numbers` table
(B11) and `call_logs.phone_number_id`; changes no existing row. Before it: `20261023100000_knowledge_per_agent` — the
table `knowledge_source_agents` (which agents may use a document; no row = shared, so nothing changes for existing
documents). Before that: `20261022120000_multiple_agents_per_tenant` — `agent_configs` is
one row per agent (`name`, `status`, `default_for`; the one-row-per-tenant unique index is dropped), and
`conversations`, `call_logs`, `records` gain `agent_id`. Every existing row becomes its tenant's default agent and
existing conversations/calls/requests are stamped with it, so nothing changes for a current tenant. Before it:
`20261021120000_conversation_handoff_state` (`conversations.handoff_state`) and
`20261020100000_two_languages_and_collect` (collect settings, `customers`, `records`). After applying any migration:
`npx prisma generate`, restart `npm run dev` **and** `npm run voice` (the gateway keeps its own Prisma client and
a 60 s settings cache), then `npm run db:check`.
