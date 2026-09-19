@AGENTS.md

# Caller AI Agent — project guide

> Read this first in every new session. It describes **what we are building, who owns
> which half, what already exists, and the conventions that must not drift.**
> If something here contradicts the code, the code wins — fix this file in the same change.

---

## 1. What the product is

A **multi-tenant AI agent platform for businesses**. "Caller" is the repo name, but calling
is only one channel. A business signs up, trains the agent on its own material, customizes
it, and then that same agent serves its customers across **every** channel:

| Channel | What it means |
| --- | --- |
| **Chat widget** | An embeddable widget any business can drop into its website or mobile app. Fully themeable per tenant: logo, colors, position, greeting, fonts, launcher icon. |
| **WhatsApp** | Inbound/outbound WhatsApp automation on the tenant's own business number. |
| **Voice — app/web** | In-app and in-browser calls (WebRTC), no phone number needed. |
| **Voice — telephony** | Real inbound **and** outbound phone calls on a real number provisioned per tenant. |

Every channel is a thin adapter over **one shared brain**. A tenant configures its agent once
— business name, purpose, tone, hours, escalation rules, knowledge base — and that config
applies identically whether the customer typed in the widget, messaged WhatsApp, or called
the number. A conversation that starts on one channel can continue on another.

**Bar for quality: this is a commercial product, not a demo.** Professional UX, real error
states, real loading states, no placeholder copy shipped to tenants.

---

## 2. Who owns what

The repo is split down one line, and **we stay on our side of it**:

- **Us (this repo's focus) — the AI engine.**
  RAG pipeline, the agent brain, channel adapters (widget / WhatsApp / voice), the embeddable
  widget itself, telephony + WebRTC plumbing, tool-calling, conversation storage, i18n of
  everything user-facing on our side.

- **Partner — the multi-tenant platform.**
  Tenants, users, auth, roles, billing/plans, the admin dashboard where a business edits its
  agent (business name, purpose, prompts, widget theme, phone numbers), onboarding, quotas.

**Practically:** we never create or migrate tenant tables. We **consume** `tenantId` as an
opaque string and scope every query by it. We do not invent our own tenants table.

**DECIDED — agent configuration lives on our side.** The `agent_configs` table is in the
`ai_engine` schema and the partner's dashboard edits it through `PUT /api/agent-config`.
Persona, capabilities and widget theme all change whenever the prompt pipeline changes, so
keeping them here means prompt iteration never waits on his migrations. He keeps tenants,
users, auth, plans and billing.

**Anything else we ever need from `tenant_core` gets fetched inside
[`src/lib/tenant/config.js`](src/lib/tenant/config.js) and merged into the object it returns**,
so the rest of the codebase never learns which side a given field came from. That file is the
seam — one function, one shape, one cache.

---

## 3. Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | **Next.js 16.3.5**, App Router, **JavaScript (not TS)** | ⚠️ This Next.js has breaking changes vs. training data — see `AGENTS.md`, read `node_modules/next/dist/docs/` before writing framework code. |
| UI | React 19.2, **Tailwind CSS v4** (`@import "tailwindcss"`, CSS-first `@theme`) | No `tailwind.config.js` — v4 config lives in `src/app/globals.css`. |
| DB | **Postgres 16 + pgvector** (`pgvector/pgvector:pg16` via `docker-compose.yml`) | Single DB shared with the partner; separated by **schema**. |
| ORM | **Prisma 6**, `postgresqlExtensions` preview feature | Our schema is `ai_engine`. Partner's is `tenant_core`. (`multiSchema` is GA in Prisma 6 — no longer a preview flag.) |
| LLM + embeddings | **Google Gemini** via `@google/genai` | Chat: `gemini-3.6-flash`. Embeddings: `gemini-embedding-001` pinned to **768 dims**. |
| Alias | `@/*` → `./src/*` (`jsconfig.json`) | |

**Not yet chosen — decide before building (see §8):** telephony provider, WhatsApp provider,
STT/TTS (or a realtime speech-to-speech model), object storage for recordings.
*i18n is settled: no library, see §6.*

---

## 4. Repo layout

```
prisma/
  schema.prisma              # ai_engine schema only — read the header comment
  migrations/
scripts/
  check-locales.mjs          # key + placeholder parity; runs on `npm run build`
src/
  app/
    api/
      agent-config/route.js          # GET/PUT  — internal: partner's dashboard
      agent-config/catalog/route.js  # GET      — internal: capability list for his UI
      widget-keys/route.js           # CRUD     — internal: key provisioning
      ingest/route.js                # POST     — internal: add knowledge
      widget/route.js                # POST+OPTIONS — ★ PUBLIC, see its guard chain
    page.js                  # manual test harness, NOT the real widget
    layout.js
    globals.css              # Tailwind v4 theme
  locales/
    en|it|ar|ur/             # common.json, widget.json, errors.json — en is source of truth
  lib/
    db.js                    # PrismaClient singleton (globalThis in dev)
    i18n/
      index.js               # t, translator, resolveLocale, dirFor, CLDR plurals
      catalogs.js            # static imports — do NOT use from the widget bundle
    auth/
      internal.js            # shared-secret guard for server-to-server routes
    security/
      origin.js              # origin allowlist + CORS
      rate-limit.js          # per-key and per-conversation limits
      session.js             # HMAC conversation tokens
    tenant/
      config.js              # ★ agent config seam (persona, capabilities, theme)
      registry.js            # ★ tenant resolution seam — swap here for tenant_core
    agent/
      gemini.js              # embedText() + generateReply() — the only Gemini touchpoint
      ingest.js              # chunk -> embed -> INSERT knowledge_chunks
      retrieve.js            # embed query -> cosine kNN over the tenant's chunks
      prompt.js              # ALL prompt text — config becomes behavior here
      respond.js             # THE BRAIN — channel-agnostic
      capabilities/
        catalog.js           # what the agent can DO, per channel
docker-compose.yml           # local Postgres+pgvector
```

---

## 5. Architecture rules

### 5.1 One brain, many thin adapters
`src/lib/agent/respond.js` is the single entry point for *every* channel. It takes
`{ tenantId, conversationId, channel, userMessage }` and returns `{ reply }`. It persists the
user message, loads history, runs retrieval, builds the system instruction, calls the LLM,
persists the reply.

**A channel adapter's only job is:** parse the transport (HTTP body, WhatsApp webhook payload,
voice transcript), ensure a `Conversation` row exists, call `respond()`, translate the reply
back into that transport (JSON, WhatsApp send API, TTS audio). **No prompt text, no retrieval,
no model calls in an adapter, ever.** That rule is why behavior can't drift between channels —
keep it. `src/app/api/widget/route.js` is the reference implementation; copy its shape.

### 5.2 Tenant isolation is non-negotiable
Every table carries `tenant_id` and every query filters on it. Never expose an endpoint that
can read another tenant's conversations or chunks.

**A public endpoint never accepts `tenantId` from the caller.** It resolves a public key
through [`lib/tenant/registry.js`](src/lib/tenant/registry.js) and uses what comes back.
Internal (`INTERNAL_API_KEY`-guarded) routes may take `tenantId` as a query param, because the
caller is our partner's backend, not a browser. When you add WhatsApp or voice, the tenant
comes from the provider's identifier for that number — resolved in `registry.js`, never
trusted from a payload.

### 5.3 The model never silently mutates tenant data
Tool-calling (book appointment, issue refund, update record…) plugs into step 5 of
`respond.js`. Every executed action gets a row in `agent_actions` with a structured `payload`
(JSON, never a text blob). That table is the audit log.

### 5.4 Vectors go through raw SQL
Prisma Client has no `vector` type — the column is `Unsupported("vector(768)")`. Reads and
writes of `embedding` use `prisma.$queryRaw` / `$executeRaw` with a bracketed float list cast
with `::vector`. Everything *else* on those models uses normal Prisma Client.

### 5.5 768 dimensions is a three-way contract
`EMBEDDING_DIMENSIONS` in `gemini.js` == `vector(768)` in `schema.prisma` == every stored row.
Changing the embedding model means changing the column **and re-embedding all existing rows**
in the same migration. You cannot mix dimensions in one column.

### 5.6 API routes always return JSON
Wrap handlers in try/catch and return `NextResponse.json({ error }, { status })`. An uncaught
throw sends an empty body and the client sees "Unexpected end of JSON input" instead of the
real cause. Same on the client: read `res.text()` then `JSON.parse` so a crashed dev server
produces a readable message (`readJsonSafe` in `page.js`).

---

## 6. Internationalization (required, not optional)

Tenants and their customers are **English, Italian, Arabic, Urdu** speakers. Nothing
user-facing is ever a hardcoded string.

**Built — see [`src/lib/i18n/`](src/lib/i18n/index.js) and `src/locales/`.**

- **Everything user-facing is a key → string lookup.** `t({ locale, key: "widget:input.send" })`
  or `translator(locale)` to bind once. Keys are `namespace:path`.
- **Catalogs:** `src/locales/<locale>/<namespace>.json` — `common`, `widget`, `errors` across
  `en`, `it`, `ar`, `ur`. **`en` is the source of truth**; a missing key falls back to `en`,
  never to a blank or the raw key.
- **`npm run i18n:check` enforces key parity and placeholder parity, and `npm run build` runs
  it.** Translation rot is silent by nature — adding a key to `en` and forgetting the rest is
  invisible without a mechanical check. Do not weaken this to unblock a build.
- **Plurals go through `Intl.PluralRules`**, never `count === 1 ? a : b`. **Arabic has six
  plural categories** (zero/one/two/few/many/other) and the naive check gets nearly every
  Arabic sentence wrong. The parity checker compares plural keys by *base* name so a locale
  can have exactly the forms its language needs; it only requires `_other`, which every
  language has. A plural form may legitimately omit `{count}` — Arabic's dual "رسالتان"
  already means "two messages".
- **`ar` and `ur` are RTL.** Use `dirFor(locale)` on the element, and logical CSS properties
  (`ms-*`/`me-*`, `start`/`end`) not `left`/`right`. Setting `dir` is not cosmetic — it's what
  makes bidirectional text, caret movement and selection behave. CSS alone does not.
- **Locale resolution** is `resolveLocale()`: explicit user choice → `Accept-Language` → tenant
  default, every candidate filtered against **what the tenant has enabled**. A business
  operating only in English and Arabic must never answer in Urdu because a browser asked.
- **The agent replies in the locale too** — `conversations.locale` feeds `prompt.js`, which
  tells the model to answer in that language *even when the retrieved knowledge is in another
  one*. Without that instruction the model drifts into the language of the documents it read.
- **No i18n framework, deliberately.** The widget ships onto other people's websites, where
  every kilobyte is a cost we impose on someone else's page load.

**Known gaps:** the translations are not native-reviewed — get `it`/`ar`/`ur` checked by
speakers before launch. The admin harness UI is still English-only (fine; it's internal).
Fonts only preload Latin glyphs, so the widget needs an Arabic-capable font stack in Phase 2.

---

## 7. What actually exists today (as of this writing)

Working, end to end: **ingest a document → ask a question → get a RAG-grounded answer, with
history persisted per tenant.**

- ✅ **DB** — `docker-compose.yml` runs Postgres 16 + pgvector. Initial migration applied:
  `conversations`, `messages`, `knowledge_chunks`, `call_logs`, `agent_actions`, all in the
  `ai_engine` schema, all indexed by `tenant_id`.
- ✅ **Gemini wrapper** (`lib/agent/gemini.js`) — lazy client, `embedText()` (768-dim),
  `generateReply({ systemInstruction, history })`.
- ✅ **Ingest** (`lib/agent/ingest.js`) — 500-word chunks with 50-word overlap, embedded and
  inserted via raw SQL. Deliberately simple chunking.
- ✅ **Retrieval** (`lib/agent/retrieve.js`) — cosine kNN (`<=>`), tenant-scoped, `topK=5`.
- ✅ **Brain** (`lib/agent/respond.js`) — persist → config + history + retrieval in parallel →
  resolve locale → build system instruction → generate → persist.
- ✅ **Widget adapter** (`api/widget/route.js`) — creates a conversation on first message,
  returns `{ conversationId, reply, locale }`.
- ✅ **Ingest endpoint** (`api/ingest/route.js`) — internal-auth guarded.
- ✅ **Test harness** (`app/page.js`) — config / key / ingest / chat panels, with a locale
  switcher and RTL preview. Uses the real public auth path, not a shortcut.

### ✅ Phase 1a — tenant config seam (done)
- **`agent_configs` table** — one row per tenant: business name, purpose, tone, timezone,
  languages + default locale, hours, escalation, capabilities, widget theme.
  `conversations.locale` added in the same migration.
- **[`lib/tenant/config.js`](src/lib/tenant/config.js)** — `getAgentConfig()` (60s in-process
  cache), `saveAgentConfig()`, `invalidateAgentConfig()`. Returns defaults for an un-onboarded
  tenant rather than throwing, so the widget can be embedded before setup finishes.
- **[`lib/agent/capabilities/catalog.js`](src/lib/agent/capabilities/catalog.js)** — the
  catalog of what the agent can *do*: `collect_contact_info`, `book_appointment`,
  `take_message`, `check_order_status`, `transfer_to_human`. Each declares which channels it
  can run on and whether it needs a tool. `resolveCapabilities()` intersects catalog support
  with tenant settings and the current channel.
- **[`lib/agent/prompt.js`](src/lib/agent/prompt.js)** — all prompt text lives here.
  Identity → tone → **channel style** → language → hours → capabilities → escalation →
  knowledge → grounding rule.
- **`/api/agent-config`** (GET/PUT) + **`/api/agent-config/catalog`** (GET) — the partner's
  dashboard contract, guarded by `INTERNAL_API_KEY` via
  [`lib/auth/internal.js`](src/lib/auth/internal.js).

Two rules established here that later phases must not break:
1. **`TOOL_EXECUTION_AVAILABLE` in `prompt.js` is `false`.** Capabilities flagged
   `requiresTool` are described to the model but wrapped in a guard forbidding it from
   claiming an action is done. Flip it in Phase 4, *after* tools actually execute — a model
   told it can book with no tool behind it will confidently confirm a booking that never
   happened.
2. **Voice replies must never contain markdown.** `CHANNEL_STYLE.voice` in `prompt.js` forbids
   asterisks, lists, emoji and URLs, because every token is read aloud.

### ✅ Phase 1b — public channel auth (done)

`tenantId` is **never** accepted from a request body any more. The widget sends a public key.

- **`widget_keys` table** — `pk_…` public keys (Stripe-publishable-key model: safe in a
  `<script>` tag), per-key origin allowlist, soft revocation via `revokedAt`.
- **★ [`lib/tenant/registry.js`](src/lib/tenant/registry.js) — THE TENANT RESOLUTION SEAM.**
  Every public endpoint answers "which tenant is this, and may they be served?" here and
  nowhere else. **When `tenant_core` lands, change `assertTenantServiceable()` in that file
  and nothing else** — it's already called on every public request, so wiring in
  active/suspended/quota checks is a function-body change. Never let tenant-state checks leak
  into route handlers; the day one of them is missed is the day a suspended tenant keeps
  being served.
  A `DEV_WIDGET_KEY` / `DEV_WIDGET_TENANT_ID` escape hatch resolves a key with no DB row,
  **hard-gated on `NODE_ENV`** — it cannot be switched on in production by setting an env var.
- **[`lib/security/origin.js`](src/lib/security/origin.js)** — origin allowlist + CORS.
  An **empty allowlist means same-origin only, never "allow everything"** — that's the state
  a freshly created key is in, and it has to fail closed.
- **[`lib/security/rate-limit.js`](src/lib/security/rate-limit.js)** — per key (120/min,
  loose: one busy site shares a key) and per conversation (20/min, tight: no human types that
  fast). In-process — see the file header before scaling out.
- **[`lib/security/session.js`](src/lib/security/session.js)** — conversations are continued
  with an HMAC token, not just their id. A leaked `conversationId` alone can't read or write
  someone else's chat.
- **`/api/widget-keys`** (GET/POST/PATCH/DELETE, internal-guarded) — provisioning for the
  partner's onboarding flow.

The guard chain in [`api/widget/route.js`](src/app/api/widget/route.js) is **ordered by cost**:
key → origin → per-key rate limit → tenant serviceable → conversation ownership → per-conversation
rate limit → *only then* embeddings and generation. Keep that order when adding channels;
abuse should be rejected before it spends money. Unknown/revoked/wrong-tenant all return the
same error, so the endpoint can't be used to probe which keys or conversations exist.

### ✅ Phase 1c — i18n (done)
See §6 for the rules. In short: `src/locales/{en,it,ar,ur}/{common,widget,errors}.json`,
[`lib/i18n`](src/lib/i18n/index.js) (`t`, `translator`, `resolveLocale`, `dirFor`, CLDR
plurals), and `scripts/check-locales.mjs` wired into `npm run build`. **Every error the widget
route returns is translated** — those strings appear inside a business's chat window, and an
English error in an otherwise Arabic interface is that business's embarrassment, not ours.

### ✅ Verified at runtime (2026-09-19)
Phase 1 has now been **executed against a live database**, not just built. Confirmed working:
migrations applied with data intact · agent config save + validation (CSS-injection and bad
locale rejected) · all four guards on `/api/widget` (no key, `tenantId`-in-body, forged key,
wrong origin) · RAG replies grounded in tenant knowledge · conversation continuation, and both
hijack attempts rejected · replies in English, Italian and **Arabic** (English knowledge
translated correctly; Arabic stored and returned intact) · locale falling back when a tenant
hasn't enabled it · **the booking guard holding under direct pressure to confirm and invent a
reference number** · per-key rate limit firing at exactly request 121 of 120 with `Retry-After`.

**Added as a result:** `withRetry()` in [`gemini.js`](src/lib/agent/gemini.js). Gemini returned
503 "high demand" on roughly 1 call in 5 during that run, and each one reached the customer as
a generic error. Retries 429/5xx only, 3 attempts, exponential backoff with jitter.
⚠️ The retry *branch* has not itself been observed firing — the 503s stopped before it could
be confirmed. Treat it as unverified until you see a `[gemini] … retrying` line in the log.

### Not started
Real embeddable widget · widget theming applied · WhatsApp · any voice or telephony ·
tool execution · streaming responses · knowledge management (delete / re-ingest / upload) ·
automated tests · CI.

### Database
**The database is `caller-ai-agent`** (matches `docker-compose.yml`). An older `nyron`
database also exists on the same Postgres from early development; its `ai_engine` schema was
copied into `caller-ai-agent` and it is now **an untouched backup, not in use**. Nothing
should point at it — if you see `nyron` in a connection string, it's stale.

### Known rough edges (fix when touching that area)
- `README.md` is still the create-next-app default.
- Translations in `src/locales/it|ar|ur` are **not native-reviewed** — have a speaker check
  them before any real customer sees them.
- Fonts preload Latin glyphs only (`layout.js`); Arabic/Urdu fall back to a system font.
  Fine for the admin harness, **not** for the widget.
- `call_logs` and `agent_actions` tables exist but nothing writes to them yet.
- No similarity index on `knowledge_chunks.embedding` — intentional until data volume
  justifies it; `retrieve.js` has the HNSW statement ready in a comment.

---

## 8. Roadmap / what to build next

Rough order — confirm with the user before starting a new pillar.
**Phase 1 is complete (1a, 1b, 1c — see §7).** Next is the widget itself: every seam it needs
now exists.

0. ~~**1a — tenant config seam**~~ ✅ · ~~**1b — public channel auth**~~ ✅ ·
   ~~**1c — i18n**~~ ✅
1. **Real chat widget** — standalone embeddable bundle + loader script, `postMessage`-isolated
   from the host page, session persistence, streaming replies, mobile-friendly, RTL-ready.
   The auth path it needs already exists: send `publicKey`, store the returned
   `conversationToken`, and put `?key=` on the URL so the CORS preflight can resolve it.
2. **Widget theming** — reads `config.widget` (already in `agent_configs`, already validated,
   not yet consumed by any UI). Use logical positioning so `ar`/`ur` flip correctly.
3. **Onboarding snippet** — the partner's dashboard shows a business its embed line. Needs
   `POST /api/widget-keys` on tenant creation, then `PATCH` to add their origin.
4. **Knowledge management** — today ingest is insert-only: no listing, no delete, no update,
   so re-uploading a document silently duplicates its chunks and pollutes retrieval. Needs
   file upload (PDF/DOCX/TXT) + URL crawl, delete/re-ingest by source, job status, and auth
   on `/api/ingest`.
5. **Tool execution.** Register each enabled capability's `toolName` as a Gemini
   function declaration, execute it, log every executed call to `agent_actions`, then flip
   `TOOL_EXECUTION_AVAILABLE` in `prompt.js`. Not before — see §7.
7. **WhatsApp adapter** — webhook in, send API out, same `respond()` call. If `respond.js`
   needed changing to make it work, the adapter boundary leaked.
8. **Voice** — WebRTC (web/app) first, then telephony numbers with inbound + outbound;
   `call_logs` + recordings to object storage. Inbound routing is `dialed number → tenant`,
   a mapping to agree with the partner (he provisions, we route).
9. **Hardening** — per-tenant usage/cost tracking (he needs this for billing; agree the event
   shape early), observability, retrieval evals, tests, CI, deploy.

**Open decisions to make with the user, not alone:** telephony/WhatsApp providers, realtime
voice approach (STT→LLM→TTS pipeline vs. a speech-to-speech model like Gemini Live), object
storage, whether the widget ships as its own bundle or a Next route.

---

## 9. Local setup & commands

```bash
npm run db:up            # start Postgres+pgvector
npm run prisma:migrate   # apply migrations
npm run prisma:generate  # regenerate client
npm run dev              # http://localhost:3000 -> test harness
npm run i18n:check       # translation key + placeholder parity
npm run lint
npm run build            # runs i18n:check first, then next build
```

`.env` — see `.env.example` for all of them, with notes:
- `DATABASE_URL` (must include `?schema=ai_engine`) and `GEMINI_API_KEY` — required.
- `INTERNAL_API_KEY` — guards server-to-server routes. **Fails closed in production** if unset;
  allowed (with a warning) in dev, which is what lets the test harness call them from a browser.
- `WIDGET_SESSION_SECRET` — signs conversation tokens. Required in production; in dev a random
  per-process secret is generated, so conversations stop resuming after a restart.
- `DEV_WIDGET_KEY` / `DEV_WIDGET_TENANT_ID` — resolve a widget key with no DB row. **Hard-gated
  on `NODE_ENV`; cannot be enabled in production.**

`.env*` is gitignored — never commit real keys; update `.env.example` instead.

---

## 10. Working conventions

- **JavaScript, not TypeScript.** Use JSDoc on exported functions, like `lib/agent/*` does.
- **Comments explain *why*, not *what*.** The existing files set the bar — match that density
  and tone. Non-obvious constraints (the 768-dim contract, the raw-SQL reason, the schema
  split) get a comment so the next session doesn't undo them.
- **Don't add dependencies casually.** The stack is deliberately small.
- **Gemini model names get retired.** If `generateReply()` 404s, the error names the
  replacement — swap `CHAT_MODEL` in `gemini.js`; nothing else depends on it.
- **`AGENTS.md` is auto-generated** by `next dev`. Don't fight it; commit it with your work.
- Branch is `master`; PRs target `main`.
