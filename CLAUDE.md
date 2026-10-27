@AGENTS.md

# Caller AI Agent — project guide

> **Read this file first, in full, before writing any code.** It is the handover
> document: what we are building, what we deliberately are not, which decisions
> are already settled and must not be re-litigated, and where the traps are.
>
> If this file and the code disagree, **the code wins** — and fix this file in
> the same change.
>
> **Documents that are handed to someone must never be out of date** — this file, `README.md`,
> `docs/handoff-to-backend.md`, `src/lib/standins/README.md`, `.env.example`. A change that alters
> behaviour, ownership, an API, a migration, a command or a test count updates them **in the same
> commit**. The checklist is in §11.

---

## 1. What this is

**An AI phone agent for small businesses.** A business trains an agent on its
own material — price list, opening hours, policies — and that agent then answers
their customers **on the telephone**.

The product is a **calling system**. Everything else exists to serve that.

| | |
| --- | --- |
| **The channel we are building** | Voice, over real phone numbers (Twilio — §6.30, §9.2) |
| **What exists today** | The RAG engine underneath it; **voice calls from the browser** (local STT/TTS, a separate voice gateway, full call logging — §6.24); a test chat to exercise the same brain |
| **What was removed** | An embeddable website chat widget. Deliberately, permanently. See §2. |

### The one-brain rule

Every channel is a **thin adapter over one shared brain**
([`respond.js`](src/lib/agent/respond.js)). A business configures its agent
once — name, purpose, tone, hours, what it may do, what it knows — and that
configuration applies identically on every channel.

An adapter's only job is: parse the transport, ensure a `Conversation` row
exists (stamped with the AGENT it is held with — §6.27), call `respond()`, translate the reply back into that transport.
**No prompt text, no retrieval, no model calls in an adapter, ever.** That rule
is the reason behaviour cannot drift between the test chat and a phone call.

---

## 2. The widget is gone — do not bring it back

The project previously shipped an embeddable browser chat widget: a loader
script, an iframe, per-tenant public keys, origin allowlists, CORS, signed
conversation tokens, widget theming. **All of it has been deleted**, from the
code and from the database.

This was a deliberate product decision, not a cleanup. The platform is a calling
system. If a browser channel is ever wanted again it should be designed fresh
against whatever the product is by then, not resurrected from git history.

**Gone, and staying gone:** `public/widget.js`, the `(widget)` route group,
`/api/widget*`, `/api/widget-keys`, `widget_keys`, `agent_configs.widget`,
`lib/security/origin.js`, `lib/security/session.js`, `lib/security/widget-guard.js`,
the `widget` translation namespace. WhatsApp was never built and is not planned.

**What replaced it:** [`/api/chat`](src/app/api/chat/route.js) — an
**internal, INTERNAL_API_KEY-guarded test surface**. It exists so a human can
type questions at the agent, which is far faster than placing a phone call to
prove a prompt change worked. It is not a product channel and must never be made
public.

---

## 3. Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | **Next.js 16.3.5**, App Router, **JavaScript (not TS)** | ⚠️ Breaking changes vs. training data — read `node_modules/next/dist/docs/` before writing framework code. |
| UI | React 19.2, **Tailwind v4** (CSS-first `@theme`) | No `tailwind.config.js`; config is in `src/app/globals.css`. |
| DB | **Postgres 16 + pgvector** | Our schema is `ai_engine`; the partner's is `tenant_core`, same database. |
| ORM | **Prisma 6** | See §6.1 — Prisma cannot see the HNSW index and keeps trying to drop it. |
| **Chat model** | Pluggable: `LLM_PROVIDER` = `gemini` \| `groq` \| `openrouter` | Via [`llm.js`](src/lib/agent/llm.js). Groq is the fast one for voice (§6.24). |
| **Embeddings** | **Gemini only — not swappable** | `gemini-embedding-001` @ 768 dims. §6.2 explains why this is a correctness constraint. |
| Documents | `pdfjs-dist`, `mammoth`, `tesseract.js`, `@napi-rs/canvas` | All four in `serverExternalPackages`; see §6.8. |
| File storage | **Cloudinary** (`resource_type: raw`) | The ORIGINAL uploaded file only — never what the agent answers from. See §6.13. |
| HTTP client (crawl only) | **`undici`**, not global `fetch` | Needed to pin a crawled connection to the exact IP already validated. See §6.9. |
| Test console editor | `@uiw/react-codemirror` + `@codemirror/*` | Edit-in-modal for typed/`.txt`/`.md` documents. Needs an explicit theme + `style={{height:"100%"}}` — see the comment at its call site in `page.js`, both are easy to lose on a refactor. |

---

## 4. Who owns what

**The split (agreed with the partner — `docs/handoff-to-backend.md` is the contract):**

| The BACKEND (partner — Abdul Haseeb) STORES and MANAGES | The ENGINE (us) USES it to do the AI work |
| --- | --- |
| Tenants, users, auth, roles, billing, plans, quotas, onboarding, the business dashboard | `tenantId` is an opaque string; every query is scoped by it |
| **Agents** — creating, renaming, archiving them, and every agent's **settings**, versioned | Reading an agent's settings to answer (persona, hours, language, voice, checklist, forwarding) |
| **Knowledge** — uploads, original files (Cloudinary), limits, the document list, **which agents use each document** | Processing documents: extraction, OCR, chunking, embeddings; searching only what the agent may use |
| **Phone numbers** — buying, porting, releasing, billing, **which agent each number rings** | The lookup "this number was dialled → which tenant, which agent" and everything on the call |
| Customers, bookings / requests and the staff screens that confirm them | Taking the request in conversation (the checklist engine) and handing it over |
| Integration secrets of its own (storage, billing, messaging, Twilio account) | The engine's own secrets (model keys); the shared internal key and event-signing secret |

We **never** create or migrate tenant tables.

**TODAY the backend half does not exist yet, so the engine STANDS IN for it** — on purpose, behind
seams, so the whole product can be built and tested end to end now and his side can replace ours
without a refactor:

| Stood in here | Where | The seam it is read through (the only code that changes when his API exists) |
| --- | --- | --- |
| Agents and their settings | `agent_configs` | [`tenant/config.js`](src/lib/tenant/config.js) — `getAgentConfig`, `listAgents` (§6.27) |
| Which agents use each document | `knowledge_source_agents` | [`lib/agent/knowledge-access.js`](src/lib/agent/knowledge-access.js) (§6.28) |
| Phone numbers → agent | `phone_numbers` | [`tenant/registry.js`](src/lib/tenant/registry.js) `resolveDialledNumber()` (§6.29) |
| Customers, requests, engine → backend events | `customers`, `records` | [`src/lib/standins/`](src/lib/standins/README.md) (§6.25) |
| May this tenant be served? | (nothing stored — always yes) | `registry.js` `assertTenantServiceable()` — edit **only** that function (§6.18) |

The engine's routes that WRITE these (`PUT /api/agent-config`, `/api/agents`, `/api/collect`,
`/api/numbers`, the `agents` of `/api/knowledge`) are the stand-in dashboard: they exist so the test
console works today and so the partner sees the exact shapes his side needs. When his side lands,
they go away and the seams read from his `/internal/*` API (handoff doc). **Do not grow them into a
second backend**, and never let engine code read the stood-in tables except through the seams.

Never let tenant-state checks leak into route handlers. The day one is missed is
the day a suspended tenant keeps being served. **Routes don't call
`assertTenantServiceable()` directly — they call `requireServiceableTenant()`**,
the translated, route-facing wrapper next to it in the same file. It is called
from every route that serves or mutates a tenant's data: `/api/chat`, all of
`/api/knowledge` (upload/crawl/typed-text, edit, delete, retry) and
`PUT /api/agent-config`, `POST /api/agent-config/summary`, `/api/agents`, `/api/collect` and `/api/numbers`. See §6.18.

---

## 5. Repo layout

```
prisma/schema.prisma           # ai_engine only — read its header
prisma/migrations/             # some hand-written (incl. embed_hash, §6.21): Prisma would emit a DROP INDEX for the HNSW index (§6.1)
docker-compose.yml             # Postgres 16 + pgvector — `npm run db:up`
tests/                         # `npm test` — node:test, no deps, NO database/network/quota (§8, §11)
test-docs/                     # the 12-file fixture corpus `eval:real` ingests (+ TESTING-GUIDE, TEST-REPORT, RETEST-REPORT)
eng.traineddata                # Tesseract language data for OCR (§6.5); Urdu (urd.traineddata) is gitignored, fetched on demand
models/voice/                  # local speech models, ~1.3 GB — GITIGNORED; `npm run voice:models` fetches them (§6.24)
public/voice/mic-worklet.js    # browser mic capture → 16 kHz PCM16 frames (AudioWorklet; loaded by URL, cannot be bundled)
scripts/
  voice-gateway.mjs            # `npm run voice` — starts the voice gateway process (§6.24)
  voice-models.mjs             # `npm run voice:models` — resumable download of the speech models
  voice-smoke.mjs              # `npm run voice:smoke` — speech benchmark, ZERO quota; `-- --call` = a real call with a synthetic caller
  voice-gaps.mjs               # `npm run voice:gaps` — silence at every join inside a spoken reply, real voices, before vs now, ZERO quota (§6.24)
  check-locales.mjs            # translation parity; runs on `npm run build`
  check-db.mjs                 # guards the HNSW index Prisma keeps dropping (§6.1)
  eval-retrieval.mjs           # fast fixture-only smoke check — not the hybrid pipeline (§6.3)
  eval-retrieval-real.mjs      # THE retrieval gate — real hybrid pipeline, full test-docs corpus (§6.3)
  chat-probe.mjs               # REAL chat calls through respond(), with a hard cumulative call budget (counter file) — scarce quota (§6.10)
  audit-chunks.mjs             # `npm run audit:chunks` — per-document chunk stats over test-docs/, read-only, offline (§6.23)
  eval-trigger.mjs             # `npm run eval:trigger` — rewrite-trigger precision/recall, regex only, ZERO quota (§6.19)
  eval-keyword.mjs             # `npm run eval:keyword` — keyword-only, SQL over stored chunks, ZERO quota (§6.22)
  eval-retrieval-real.baseline.json  # saved numbers eval-real diffs against; commit changes deliberately
  eval-questions.mjs           # the labelled question set, shared by both real-path evals
  eval-embedding-variants.mjs  # picks an embedding scheme IN MEMORY before anything is re-embedded (§6.2, §6.20)
  test-collect*.mjs            # `npm run test:collect` — request-taking end to end against the real DB, faked models, ZERO quota (§6.25)
  test-agents.mjs              # `npm run test:agents` — several agents per tenant + knowledge per agent against the real DB, faked models, ZERO quota (§6.27, §6.28)
  test-numbers.mjs             # `npm run test:numbers` — the phone-number lookup against the real DB, ZERO quota (§6.29)
  test-reembed*.mjs            # `npm run test:reembed` — ingest/re-embed invariants with a faked embedder, no quota
  repro-tenant-recall.mjs      # synthetic multi-tenant data: does the shared HNSW index lose a tenant's rows? (§6.1)
  backfill-search-config.mjs   # `npm run db:backfill-search` — label chunks with their document's language; no embeddings (§6.3)
  reembed.mjs                  # resumable re-embed of existing documents under the current scheme (§6.2, §6.10)
  alias-loader.mjs / alias-register.mjs  # lets plain-node scripts import src/ (the "@/" alias) so they run the app's own code
  test-openrouter.mjs          # OpenRouter integration vs. a local stand-in
src/app/
  page.js                      # THE TEST CONSOLE — agent bar + tabs: agent · knowledge · what it collects · numbers · call · chat
  collect/CollectPanel.js      # the "what the agent collects" checklist + the list of requests taken (§6.25)
  handoff/HandoffPanel.js      # the Agent tab's "call forwarding" settings (§6.26)
  agents/AgentPicker.js        # the "which agent" bar above the tabs: pick, add, rename, make default, archive (§6.27)
  knowledge/DocumentAgents.js  # one document's "All agents / Only: …" and its editor, in the Knowledge tab (§6.28)
  knowledge/SummaryDraft.js    # the review window for the AI's business-summary draft; SummaryPanel.js = the Agent tab's summary (§6.20)
  numbers/NumbersPanel.js      # the Numbers tab: add / link / release a number, try the lookup (§6.29)
  voice/                       # the console's voice panel: useVoiceCall (mic/socket/playback), pcm-player, panel, call history, VoicePicker, GreetingPanel (the Agent tab's call greeting + recording switch)
  api/
    chat/route.js              # internal test chat (SSE) — NOT a product channel
    voice/session/route.js     # checks the tenant, issues a one-minute ticket for the gateway's WebSocket (§6.24)
    voice/gateway/route.js     # where the gateway is (health + voice preview URLs) — for the voice picker
    voice/calls/route.js       # recent calls (summary); voice/calls/[id] = one call's turns + timeline
    agents/route.js            # list / add a tenant's agents; agents/[id] = rename, archive/restore, make default (§6.27)
    numbers/route.js           # list / add phone numbers; numbers/[id] = link to an agent, rename, release; numbers/lookup = try the routing (§6.29)
    collect/route.js           # GET/PUT the owner's "what should the agent collect" configuration (versioned, per agent)
    records/route.js           # list requests the agent took; records/[id] = read / confirm / decline one
    agent-config/route.js      # GET/PUT — partner's dashboard contract (+ summaryStatus: is the business summary out of date?)
    agent-config/catalog/      # capability list, translated, for his UI
    agent-config/summary/      # POST — the AI's DRAFT business summary of chosen documents; saves nothing (§6.20)
    knowledge/route.js         # list + add/replace: typed text, uploads, URL crawl
    knowledge/[id]/route.js    # read, edit, rename, delete one document
    knowledge/[id]/retry/route.js  # re-embed a FAILED document — no re-upload (§6.15)
    knowledge/jobs/route.js    # background import progress (§6.6)
    knowledge/jobs/[id]/route.js   # cancel ONE queued/processing job (§6.14)
    knowledge/search/route.js  # retrieval debug + eval harness (GET raw/`real=1`; POST = conversation-aware, §6.19)
    locales/route.js           # whole UI in one language, for his dashboard
src/lib/
  agent/
    llm.js                     # ★ LLM SEAM — chat swappable, embeddings are not
    gemini.js / groq.js / openrouter.js  # providers; import ONLY from llm.js. groq = the fast one (§6.24)
    openai-compatible.js       # the OpenAI chat dialect, shared by groq.js and openrouter.js
    language.js                # per-document text-search language: english | simple (Urdu) (§6.3)
    embed-scheme.js            # ★ everything that changes a stored vector + the scheme VERSION (§6.2)
    retry.js                   # shared backoff; quota vs. rate-limit
    respond.js                 # ★ THE BRAIN — channel-agnostic
    prompt.js                  # ALL prompt text
    retrieve.js                # cosine kNN + relevance threshold; rankCandidates() = pure RRF + diversity (§6.3)
    breaker.js                 # circuit breaker + timeout for the OPTIONAL rewrite call; pure, fake-clock tested (§6.19)
    prepare.js                 # text -> chunks for ingest/retry/re-embed/audits; CSV conversion at chunk time (§6.23)
    tables.js                  # pure: CSV/DOCX tables -> self-describing rows; flag OFF (§6.23)
    keyword-query.js           # pure: question -> OR tsquery of content words; flag OFF (§6.22)
    query.js                   # what gets SEARCHED for: follow-up resolution, rewrite step (§6.19)
    chunk.js                   # heading-aware splitter (§6.4); optional title-in-embedText, off (§6.20)
    extract.js                 # pdf/docx/txt/md/csv → text; editability rule (§6.7)
    ocr.js                     # scanned-PDF OCR (§6.5)
    crawl.js                   # website crawling + SSRF defences (§6.9)
    ingest.js                  # create/REPLACE/rename/delete/retry documents (§6.10, §6.15); who may use each (§6.28)
    knowledge-rules.js         # pure: may this agent use this document? (shared vs limited) — also imported by the console (§6.28)
    profile-summary.js         # the business summary: draft from chosen documents (agent-scoped), sources + staleness (§6.20)
    summary-rules.js           # pure: no prices in a summary (strip from drafts, refuse on save), length, form — also the console's
    knowledge-access.js        # the same rule as SQL (fails closed), validating and writing a document's agents (§6.28)
    jobs.js                    # background import queue + cancellation (§6.6, §6.14)
    storage.js                 # Cloudinary — the ORIGINAL file only (§6.13)
    capabilities/catalog.js    # what the agent can DO, per channel
  voice/                       # ★ THE VOICE CHANNEL (§6.24) — runs in the gateway process, never in Next
    gateway.js                 # HTTP /health + WebSocket /call; ticket check, call limits, heartbeat
    session.js                 # ★ CallSession — one live call: greet, VAD → STT → respond() → TTS, barge-in
    recorder.js                # every DB write of a call: call_logs, call_turns, call_events (batched, off the hot path)
    speech/                    # models.js (manifest) · voices.js (THE voice catalog, pure) · engine.js (loads once)
                               #   · vad.js · stt.js ★ SEAM (Parakeet / Groq Whisper, routed per call) · tts.js ★ SEAM (Kokoro / Piper, cache)
    gateway-url.js             # where the browser reaches the gateway — shared by the session and gateway routes
    transports/browser.js      # the console's WebSocket protocol
    transports/twilio.js       # a PHONE call over Twilio Media Streams: μ-law frames, barge-in clear, ordered transfer (§6.30)
    protocol.js                # message types shared by gateway and browser
    config.js                  # every tunable: VAD silence, barge-in, filler, limits
    closing.js                 # when a call ends by itself (goodbye, "no thanks" after "anything else?", the agent's farewell) + the per-agent switch and delay — pure (§6.26)
    greeting.js                # each agent's call greeting: built-in text (AI notice; recording notice only while recording is on), the owner's own text, the console's warnings — pure (§6.24)
    sentences.js · intent.js · spoken-language.js · vocabulary.js · ticket.js · audio.js · serial.js   # pure, unit-tested
  collect/                     # ★ REQUEST-TAKING (§6.25) — what the agent collects, validates and hands over
    catalog.js                 # field catalogue, record types, industry presets, limits — DATA, not code
    config.js                  # per-tenant collect config: normalise/validate, preset, describeCatalog
    engine.js                  # ★ advanceCollection — the deterministic state machine that owns a request
    extract.js / validate.js / phrases.js / marker.js / store.js   # understanding, judging, small words, start marker, draft persistence
    order.js                   # an order read against the MENU: dishes + quantities, merging changes, display — pure
  handoff/                     # ★ PASSING A CALLER TO A PERSON (§6.26) — settings, the decision (pure), the per-turn glue
    config.js / phrases.js / decide.js / turn.js   # escalation settings · asking-for-a-person & not-understood rules · decideHandoff · what respond() gets back
  phrases/                     # ★ GENERIC OPENERS (§6.20): en.js · ur.js · roman-ur.js = the WORDS, one file per way of writing (who-are-you / about / offerings / help / are-you-a-robot; PAUSES: hold-on / still-here; CLOSINGS: anything-else / no-thanks / farewell; question words, filler, greeting notice words) · index.js = the matcher, pure
  standins/                    # fake backend (customers, records, events, phone numbers) behind fixed interfaces — what Haseeb replaces (§4, §6.25, §6.29)
  telephony/                   # routing.js (pure: E.164, who answers a number) · route-cache.js · errors.js (§6.29)
                               #   · twilio-signature / twilio-request (is it really Twilio?) · twilio-webhook (answer a call, the transfer chain) · twilio-config · twilio-rest · twiml · signed-token (§6.30)
  auth/internal.js             # INTERNAL_API_KEY guard — every route calls it (§2, §6.12)
  tenant/ config.js, registry.js   # ★ the seams (§4); registry.js: requireServiceableTenant() (§6.18), the plan's agent limit hook, resolveDialledNumber() (§6.29)
  tenant/agent-request.js      # which agent a request is for: ?agentId= → requireAgent(), agentScope() (§6.27)
  i18n/   index.js, catalogs.js    # en + ur — the only two languages (§7)
  security/rate-limit.js       # generic limiter — first wired up on /api/chat (§6.18)
  db.js                        # PrismaClient singleton
src/locales/en|ur/             # common, dashboard, capabilities, validation, errors — parity enforced on build (§7)
docs/handoff-to-backend.md     # ★ THE CONTRACT with the partner: what the backend builds, the shapes, what is stood in here
```

---

## 6. Rules that must not drift

Each of these was learned by getting it wrong first. The reasoning matters more
than the rule.

### 6.1 Prisma cannot see the HNSW index and will drop it

There is a similarity index on `knowledge_chunks.embedding`:

```sql
CREATE INDEX knowledge_chunks_embedding_idx ON ai_engine.knowledge_chunks
  USING hnsw (embedding ai_engine.vector_cosine_ops);
```

Prisma 6 has no `Hnsw` index type, so it cannot be declared in the schema — and
because Prisma does not know it exists, **`prisma migrate diff` emits a
`DROP INDEX` for it every single time.**

Dropping it is **silent**. Nothing errors, every query returns the right answer,
each one just reverts to a sequential scan. Invisible at 14 chunks; crippling at
10,000.

**Never paste a generated migration in unread.** Delete that line.
`npm run db:check` catches it if you do. (The two hand-written migrations since —
`embedding_scheme`, `chunk_search_config` — say so in their first lines, and drop
nothing.)

**The same index fails silently a second way: the tenant filter runs AFTER the
graph walk.** One HNSW index spans every tenant. pgvector fetches the
`hnsw.ef_search` (default 40) nearest chunks in the WHOLE table, then applies
`tenant_id = X` and the distance cap. If the nearest 40 belong to other tenants —
every clinic has a pricing page — a tenant that really has matching chunks gets
fewer back, or none. Seen directly: `EXPLAIN ANALYZE` showed
`Index Scan … Rows Removed by Filter: 39` beside `rows=1` where an exact scan
returned 8. No error; the answer just comes from less material (§6.3).

Be exact about what was and was not shown, because it is not what the problem
statement assumed. `scripts/repro-tenant-recall.mjs` builds a scratch table with
the same index, 24–60 synthetic tenants (7k–18k chunks) sharing topics, and one
small target tenant: **the loss appeared in ONE index build (1–4 of 8 rows found,
every query) and in none of five others** — including an 18,000-chunk build with
interleaved tenants. Index builds are randomised, so it depends on the graph you
happened to get: the most dangerous kind, a bug a test can pass by luck.
Also: at small scale the planner never uses HNSW for a tenant-filtered query at
all — with the `tenant_id` btree it reads the tenant exactly (and today's 227
chunks are a sequential scan) — so the failure needs a table big enough that
HNSW wins. It is a scale problem arriving before anyone is looking.

**Fix: `hnsw.iterative_scan = strict_order`, set with `set_config(…, true)` inside
the retrieval transaction** (`retrieve.js`). Iterative scans (pgvector ≥ 0.8.0;
the container runs 0.8.6) keep walking until the FILTERED `LIMIT` is satisfied
or `hnsw.max_scan_tuples` (20,000) is hit. Chosen over the alternatives:
- *higher `ef_search`* — a bigger fixed window, not a guarantee; max 1000, and
  it taxes every query to fix the rare one;
- *per-tenant partial indexes / partitioning* — the real answer at scale, but a
  migration per tenant and a planner dance; deferred (§9.1);
- *a database-level `ALTER DATABASE … SET`* — invisible, lost silently on a
  restored or new database; a per-transaction setting travels with the code.
`strict_order` rather than `relaxed_order` because the RRF takes the SQL order as
the vector rank. Measured cost: none (3.2 ms vs 3.5 ms average). It is
insurance, not a measured recall gain — the repro could not show a gain because
it could not reliably show the loss. The ceiling that remains is
`max_scan_tuples`: a tiny tenant in a table of millions can still be starved.
(Measured since: exactly that, at 40,000 packed rows with a 1-in-2,000 tenant — §9.1 item 3.)
**`npm run db:check` now asserts** pgvector ≥ 0.8.0 and that the setting can be
set per transaction (on an older server the query would otherwise ERROR on a
customer's call), plus the keyword-index columns of §6.3.

### 6.2 The chat model is swappable. The embedding model is NOT.

`embedText()` is hard-wired to Gemini and takes no provider argument.

Embeddings from two models are coordinates in **different vector spaces**.
Embedding a query with one and comparing it to chunks embedded with another
returns confident nonsense — retrieval would not error, it would quietly return
the wrong documents and the agent would answer fluently from them. That is the
worst failure mode a RAG system has.

Changing the embedding model means changing the `vector(768)` column **and
re-embedding every row** in one migration. OpenRouter has no embedding models at
all (checked across all 447), so only the chat half moves.

**Smaller changes to what is embedded have the same shape.** A document-title
prefix, a Gemini `taskType`, a different chunker — none changes the model, all
change every vector they touch, and old rows keep their old ones. The result is
not nonsense (same model, same space) but a quiet skew between chunks embedded
two ways, and the measured `MAX_DISTANCE` (§6.3) stops describing the corpus.
So they are all decided in ONE file, [`embed-scheme.js`](src/lib/agent/embed-scheme.js),
behind a version number: change a flag, bump `EMBEDDING_SCHEME_VERSION`, run
`npm run reembed`, re-run the threshold sweep. Each `knowledge_sources` row
records the version it was embedded under (`embedding_scheme`; the migration
defaults every existing row to 0), `npm run db:check` FAILS while any ready
document is behind, and `reembed` is resumable off that same column.

**`embedText(text, { role })` takes a REQUIRED `role`: "document" (a chunk
being stored) or "query" (a question being searched) — no default, it throws
without one.** That is not a provider argument (there is still exactly one
provider and no way to pass another); it is there so a caller that forgets which
side of retrieval it is on fails loudly instead of embedding with the wrong one.
Whether the role reaches the API as `taskType` RETRIEVAL_DOCUMENT /
RETRIEVAL_QUERY is `USE_EMBEDDING_TASK_TYPES` in `embed-scheme.js` — **off until
measured** with `npm run eval:embedding-variants` (§6.20). The SDK also accepts a
`title` with RETRIEVAL_DOCUMENT; it is not used — a title in the text itself
works for every role, is visible in the chunk the model is shown, and is
testable. `embedTexts(texts, { role })` embeds a batch in one request and refuses
a short or misordered reply (vectors attached to the wrong chunks would be §6.2's
failure mode again).

**Provider fallback:** `LLM_FALLBACK_PROVIDER` is tried only when the first
provider fails for *its own* reasons — rate limit, outage, bad key. A malformed
request is our bug and is never retried elsewhere.

**⚠️ Gemma has no system turn.** Its template defines only `user` and `model`. A
system message may be silently dropped, taking the persona and every guard with
it and leaving a generic assistant whose replies still look plausible. So
`openrouter.js` folds the system instruction into the **LAST (current) user
turn** — never the first, because that instruction carries the chunks retrieved
for *this* question and folding it into an old turn drifts the live context
further away every turn.

### 6.3 The relevance threshold is MEASURED, never guessed

`MAX_DISTANCE = 0.43` in [`retrieve.js`](src/lib/agent/retrieve.js).

Nearest-neighbour search **always returns something**. Ask a dental clinic about
car insurance and it hands back the five least-unrelated paragraphs it owns.
Those used to reach the prompt as REFERENCE MATERIAL with only the grounding
rule — a *request* to the model — standing between them and a wrong answer.

`npm run eval:sweep` reports the boundary:

```
hardest question that SHOULD be answered : 0.395
closest question that should NOT be      : 0.456
Suggested MAX_DISTANCE (midpoint): 0.43
```

The first value tried was **0.62** — it looked sensible and rejected **nothing**.
Re-run the sweep after changing the embedding model, the chunker or chunk size.
If the two numbers ever **overlap**, no threshold separates them and the fix is
better chunking, not a different number.

**After ANY change to what is embedded (§6.2), the boundary has to be re-measured
before `MAX_DISTANCE` is trusted again — and it can move a lot, because a
`taskType` rescales distances.** Order: (1) `npm run eval:embedding-variants` picks
the scheme on pure vectors, each candidate at its OWN midpoint threshold (a fixed
0.43 means something different in each); (2) adopt it in `embed-scheme.js` and bump
the version; (3) `npm run reembed:dry`, then `npm run reembed`; (4) `npm run db:check`;
(5) `npm run eval:sweep` and `npm run eval:real:sweep`, set `MAX_DISTANCE` from the
measured midpoint and rewrite the comment block in `retrieve.js` with the NEW
numbers; (6) `npm run eval:real` against the saved baseline. If the must-answer and
must-reject distances overlap, no threshold fixes it — fix the chunking. The
embedding quota is ~1000 texts a day (§8 limitation 3), so this is done ONCE per
batch of ideas, never once per idea. **Today the scheme is v0 and `MAX_DISTANCE`
is the 0.43 measured on it; nothing in this paragraph has been re-run yet.**

**Retrieval is now HYBRID, but the gate above is untouched.** `retrieveRelevantChunks`
pulls a wider pool of threshold-admitted candidates (`CANDIDATE_POOL_SIZE = 20`,
still every one `<= MAX_DISTANCE`), re-ranks that pool with Reciprocal Rank
Fusion against a Postgres full-text keyword score, then diversifies the final
`topK` on two axes so five near-duplicate chunks from one table can't crowd
out a relevant chunk from elsewhere. This exists because pure cosine
similarity has no special regard for an exact code, price or name — it can
rank a chunk merely "about the same topic" above the one that actually
contains what was asked. **Membership is still decided by `MAX_DISTANCE`
alone** — the keyword score only ever re-orders chunks that vector search
already allowed in; it can never admit one vector search would have rejected.
`retrieveWithoutThreshold` (the eval/debug path) stays pure-vector on purpose —
mixing in keyword scores there would defeat its one job, showing the raw
rejected-chunk distances.

> **Languages have since changed (§7): the product is English + Urdu only.** Everything below that
> mentions Italian — the 94-question set's Italian items, the `cross_language` category, every
> measured number — was measured BEFORE Italian was removed and has NOT been re-run. Today
> `detectSearchConfig` returns `english` or `simple` (Urdu script); the Italian test document is
> gone and the Italian questions in `scripts/eval-questions.mjs` were rewritten as Urdu ones that
> have never been scored. Treat the saved `eval:real` baseline as stale until the Urdu corpus is
> embedded and the run is repeated (§9.1 item 1). A pre-existing `italian` label in a database is
> relabelled by the new migration and `npm run db:backfill-search`.

**The keyword half is LANGUAGE-AWARE.** It used to be `to_tsvector('english', …)`
for everything: an Italian document got no correct stemming and its stop words
("il", "per", "della") counted as content. Now each chunk carries
`search_config` (a Postgres `regconfig`: `english` | `italian` | `simple`) and
`content_tsv`, a STORED generated column `to_tsvector(search_config, content)` —
precomputed, so no per-query tokenising of every candidate.
- **Language is decided per DOCUMENT, at ingest** ([`language.js`](src/lib/agent/language.js)),
  not per chunk: a chunk is too short to identify a language and a document is
  written in one. A stop-word ratio, no dependency. It fails toward today's
  behaviour: clear Italian → `italian`; mostly non-Latin script (dormant ar/ur) →
  `simple`; anything else, including "unsure", → `english`. `simple` is NOT the
  unsure-fallback: a CSV price table has no prose and ranked fine as English. On the
  real corpus it labels the 2 Italian documents Italian and the other 50 English.
- **The column is a `regconfig`, not text,** because a generated column needs an
  IMMUTABLE expression and `to_tsvector(text::regconfig, …)` is only STABLE.
- **No GIN index, deliberately** (it was suggested): the keyword score only RANKS
  vector-admitted rows and never filters with `@@` — filtering would let keyword
  admit a chunk vector search rejected, which is the invariant above — so nothing
  would ever use it and it would only slow writes.
- **The query is analysed with EACH CHUNK's own config** (a `CASE` over three
  `plainto_tsquery` calls, in the same statement and the same row set). Italian
  question → Italian chunk: Italian stemming on both sides. **Cross-language
  (Italian question, English chunk): the English-analysed query contributes only
  what is language-neutral** — a brand, a plan name, a number — and the vector
  half carries the meaning, exactly as before. Nothing translates, and the query's
  language never has to be detected.
- **Invariant verified, not assumed:** over 12 query/tenant comparisons the set of
  chunks admitted by the new SQL was identical to the old query's. Membership is
  still `MAX_DISTANCE` alone.
- Existing rows defaulted to `english` (= their old behaviour, so applying the
  migration changed nothing); `npm run db:backfill-search` relabelled 10 chunks
  (the 2 Italian documents) — no embeddings, no quota, no `MAX_DISTANCE` change.
  `db:check` fails on any document whose chunks are not in its language.

**What the keyword rank measurably did (pure SQL, no embeddings; `__eval_real__`):**
"piano Growth costo" now matches the Italian FAQ (rank 0.117; before: no hit — the
English stemmer left "costo"/"costa" unmatched); "abbonamenti annuali rimborso"
unchanged (0.037, already a hit). **But five natural full-sentence Italian
questions got ZERO keyword hits before AND after.** `plainto_tsquery` ANDs every
term, so one word the chunk lacks ("vostra", "trovano") zeroes the rank — the same
is true of English sentences. The stemming fix therefore helps short,
keyword-style queries; for a sentence the keyword half is mostly inert whatever the
language. An OR-style query (`to_tsquery` with `|`) would change that, and it
changes ranking for English too — now BUILT and measured keyword-only, off by default,
awaiting the integrated `eval:real` run the embedding quota is blocking (§6.22). **The before/after `eval:real`
(no category may regress, cross_language especially) has NOT been run for the same
reason** — what is established is the invariant above and the SQL-level numbers.

**STAGES 2–3 are a pure function, `rankCandidates(candidates, topK)`** (exported from
`retrieve.js`; STAGE 1, the SQL and the `MAX_DISTANCE` gate, stay in
`retrieveRelevantChunks`). Extracted verbatim — tests/rank-equivalence.test.mjs runs
the pre-refactor code (kept in tests/helpers/legacy-rank.mjs) and the new function over
5,000 seeded random candidate sets and requires identical output — and tests/rank.test.mjs
pins the conflict fixture below, heading crowding and the RRF behaviour with hand-built
rows. It must stay free of I/O.

**The diversity round-robin is by DOCUMENT first, HEADING second — heading
alone gave zero protection for two documents that disagree.** A black-box
test sweep found that asking about a price two documents quote differently
got a confident, wrong answer with no hint a second document existed, even
though the conflicting chunk was threshold-admitted (§6.10's conflict rule
never got a chance to fire — the model never saw the contradicting chunk at
all). Root cause: a single dense document naturally has many DIFFERENT
headings of its own (an intro chunk, a "Pro" chunk, a "Plan Comparison"
chunk…), so grouping only by heading text never even merges it with a
competing document's chunk — the dominant document's ten distinct headings
simply outrank the other document's one relevant chunk on fused score and
fill every round-robin slot before a second round of selection is ever
reached. Confirmed against exactly that fixture (a 10-chunk pricing sheet vs.
a 3-chunk conflicting price list): the conflicting chunk ranked 11th and
never reached a `topK` of 6. The fix round-robins across DOCUMENTS as the
PRIMARY axis — every document represented before a second chunk from any one
of them — and only then diversifies by heading within each document's own
share, which is what still protects the original single-document case (a long
price table split into sub-chunks crowding out a different section of the
SAME document). `sourceTitle` is the document identity used to group on —
unique per tenant (`@@unique([tenantId, title])`), so it's safe to key on
without an extra join.

**`npm run eval:retrieval` measures a DIFFERENT retriever than the one the
agent runs — know which number you're reading.** It scores
`retrieveWithoutThreshold` (pure vector, no RRF, no diversity) against three
tiny single-topic fixture documents. `respond.js` calls `retrieveRelevantChunks`
— threshold + hybrid RRF + document/heading diversity, above — against
whatever a real tenant actually uploaded. A change to the diversity stage, the
RRF constant or the candidate pool size can pass `eval:retrieval` unchanged,
because that script never calls the function the change is in. **`npm run
eval:real`** (`scripts/eval-retrieval-real.mjs`) closes this gap: it calls
`retrieveRelevantChunks` itself, over HTTP, via `/api/knowledge/search`'s
`&real=1` flag (read-only, internal-auth guarded, never called by the agent —
see that route's header comment); ingests the full `test-docs/` fixture pack
(12 files — PDF, DOCX, CSV, a scanned/OCR PDF, an Italian FAQ, a deliberate
cross-document price conflict, an off-topic recipe) through the real upload
path, not a shortcut; and scores a 94-question labelled set (71 standalone, 23 carrying a conversation §6.19; the set lives in `scripts/eval-questions.mjs`), per category,
against a saved JSON baseline (`scripts/eval-retrieval-real.baseline.json`) so
a later run FAILS (non-zero exit, tolerance 3 points) on a real regression
instead of silently drifting. **`eval:retrieval` is not obsolete** — it is a
fast, cheap fixture-only smoke check with no ingestion cost, still worth
running first. `eval:real` is the one that actually gates the pipeline the
agent runs, and it is slower (real ingestion, real OCR) on purpose.

**Measured baseline (`npm run eval:real`, this corpus, `MAX_DISTANCE = 0.43`,
`topK = 5` — matches `respond.js`'s `MAX_CONTEXT_CHUNKS`):**

| Category | hit@1 | hit@3 | MRR | Notes |
| --- | --- | --- | --- | --- |
| factual (24 q) | 92% | 100% | 0.958 | direct, clearly-worded questions |
| phrased_loosely (11 q) | 64% | 82% | 0.712 | natural phone-caller phrasing of the same facts |
| cross_language (10 q) | 100% | 100% | 1.000 | Italian↔English — the multilingual embedding holds up better than the keyword half (§6.2/§6.3) would suggest |
| **generic_overview (8 q)** | **0%** | **0%** | **0.000** | **"tell me about your company" / "who are you" style openers — every one returned NOTHING, not a low rank** |
| overall (53 q, excl. off-topic/conflict/followup) | 74% | 81% | 0.770 | — |
| off_topic (8 q) | — | — | — | 88% rejected; ONE leak: "What are your flight change fees?" → the refund-policy doc, 0.397 (semantic collision on "fees"/"changes", not a threshold miss) |
| conflict (3 q) | — | — | — | 100% both-sources-present — §6.10's conflict rule fires correctly, but the sweep below shows this by only 0.009 of margin |
| **followup (16 q, with conversation)** | **100%** | **100%** | **1.000** | via the rewrite step (§6.19); the SAME questions searched raw score 31% hit@1 / MRR 0.313 |
| followup_offtopic (7 q in the set, with conversation) | — | — | — | 100% rejected — a rewrite must never glue an unrelated question onto the previous topic (§6.19). **The saved baseline holds only the first 4** (n=4) — see §6.19 |
| report_phrasings (7 q) | — | — | — | the seven openers from TEST-REPORT §4 — three pass, four are declined by under 0.04 (§6.20). **Not in the baseline yet**: added after it was saved; the next `eval:real` run extends the baseline with it |

**This is the honest number CLAUDE.md should have had all along — not the
old §8 table's "100% hit@1, MRR 1.000".** That figure was never wrong for
what it measured; it was measuring the wrong thing. `npm run eval:real:sweep`
shows WHY generic_overview fails outright rather than merely ranking low:

```
category            hardest question that must be ANSWERED   vs. off-topic boundary
factual                0.316                              clear, gap 0.080
phrased_loosely        0.453                              ⚠ OVERLAPS
cross_language         0.261                              clear, gap 0.135
generic_overview       0.520                              ⚠ OVERLAPS
conflict               0.387                              clear, gap 0.009
```

A vague opener with no business-specific keyword in it embeds too far from
every chunk in the corpus to clear ANY threshold that also rejects genuinely
off-topic questions (the closest off-topic question sits at 0.397) — moving
`MAX_DISTANCE` cannot fix this without also letting car-insurance questions
through to a dental clinic's agent. The fix is not a threshold change. §6.20
adds the always-available business profile (answers "who are you / what do
you do" with no retrieval at all) and measures why retrieval itself still
fails; the retrieval half is open — see §6.20 and §9.1.

### 6.4 Chunking is heading-aware

[`chunk.js`](src/lib/agent/chunk.js) splits at headings, then paragraphs, then
sentences. Fixed-size windows cut price tables in half and split policies
mid-sentence, producing chunks that each read as a different rule.

**The heading path is prepended to `embedText` but NOT to `content`.** Under a
heading "Whitening" the body often says "250 euros" and never repeats the word —
embedded alone, that chunk cannot match "how much is whitening?". The heading
puts the words back for the vector while the quoted text stays clean.

**A plain-text heading must be short, unpunctuated, AND followed by a blank
line — markdown headings need none of this, `#` is already unambiguous.**
Without the blank-line requirement, `detectHeading()` classified lines like
`Phone: 123` or a bare URL as headings (short, title-cased, no terminal
punctuation is exactly what a real heading looks like too). A heading's own
text never enters a chunk's body, only its breadcrumb — so a contact line with
nothing under it before the next real heading **silently vanished from the
document**. Lines with an internal colon (`label: value`) or a URL/email are
now excluded outright, on top of the blank-line check.

**A single sentence (or a run of text with no terminal punctuation) longer
than `TARGET_CHARS` gets a character-count hard split.** The comment always
described this as the last-resort fallback after paragraph- and
sentence-splitting; the code didn't actually have it until it was added —
before that, an oversized run-on sentence just sailed through as one
oversized chunk. `hardSplit()` carries `OVERLAP_CHARS` backward into each
piece so a phrase landing on the cut point isn't orphaned in only one of them.

**A section's own leading runt merges FORWARD, not just backward.** A tiny
first paragraph under a fresh heading (e.g. "See below.") used to have no
same-heading predecessor to fold into and sat alone as a fragment that
matches everything weakly. `mergeRunts()` folds it into the piece that
follows within the same section before `chunkDocument`'s existing
cross-section backward merge ever runs.

**PDFs never have plain-text headings detected, because pdfjs never gives us
a blank line — so PDF headings are promoted to markdown BEFORE `chunk.js`
ever sees the text.** A black-box test sweep found a whole PDF collapsing
into two heading-less mega-chunks, one of them containing a fluent but
FABRICATED-sounding instruction ("set up your branch chains") that was
actually a hyphenated line-wrap artifact from the middle of an unsplit
1,400-character run-on sentence — the hard-split fallback above never
triggered either, because the section containing it was never recognised as
its own section in the first place. Root cause, confirmed against the actual
PDF: `extractPdf()` in [`extract.js`](src/lib/agent/extract.js) joined every
line within a page with a single `\n`, so a numbered or title-case heading
was NEVER followed by the blank line `detectHeading()`'s plain-text path
requires (added for the label/value fix above) — meaning NO PDF, ever, could
have a plain-text heading detected, no matter how clearly it read as one. A
vertical-gap heuristic was tried first and rejected: in the actual PDF tested,
an ordinary wrapped line and a genuine section break rendered with
near-identical vertical gaps, so gap alone mostly just planted blank lines
mid-sentence instead of at real breaks. **Font size is the reliable signal
instead** — verified against that same PDF: title 22pt, every numbered
section heading 15pt, all body text 11pt, with no exceptions. `extractPdf()`
now finds the document's most common line height (the body size), promotes
every line from a larger-than-body size tier to a markdown heading (largest
tier `#`, next `##`, …), and lets `chunk.js` parse those exactly like a
markdown file — no blank-line rule needed, because markdown syntax is already
unambiguous. This mirrors what `extractDocx` already does with mammoth's
heading styles; a PDF with no distinct heading size at all (headings only
bolded, not enlarged) simply yields no detected headings, same as before —
this is a best-effort structural read, not a guarantee.

### 6.5 OCR, and the detached-buffer trap

[`ocr.js`](src/lib/agent/ocr.js) renders each page with pdfjs and reads it with
Tesseract (`eng`, plus `urd` when a scanned document is mostly Urdu — the Urdu data file is downloaded on demand and gitignored). Triggered by `looksScanned()`, which tests characters
**per page** — a scan is rarely truly empty, it carries a stray header or page
number, so raw emptiness is the wrong test.

**⚠️ pdfjs DETACHES the buffer it is handed.** It transfers ownership to its
worker, so the second reader of the same upload finds an empty husk and throws
`Construct on a detached ArrayBuffer`. A scanned PDF takes exactly that path:
text extraction first, OCR second. Both readers therefore pass
`new Uint8Array(buffer.slice(0))` — a **copy**. Do not simplify that to a view.

Rendering is 2× scale: below it accuracy collapses on small type; above it the
images get slow without reading any better.

### 6.6 Slow imports run as background jobs

Embedding a large PDF is one embedding per chunk (sent 16 to a request, §6.14);
OCR is seconds per **page**. Neither belongs in an HTTP request. Uploads return **202 with job ids**
and the work continues behind them.

- **Progress lives in `ingest_jobs`, not memory** — so a business can reload
  mid-import and still see where it got to.
- **Concurrency is 1, deliberately.** The work is dominated by a per-tenant model
  quota; parallel jobs contend and fail together rather than finishing sooner.
- **One job per file.** A ten-file upload where the third is corrupt imports the
  other nine and reports that one failure.
- **`reapStaleJobs()`** marks jobs abandoned by a process restart as failed.
  Left alone they show a bar that never moves, which reads as *still working* —
  the most misleading state available.
  **It only reaps `processing` rows on a timeout — never `queued` ones on the
  same timeout.** Concurrency is 1 (see above), so a queued job can
  legitimately sit untouched for a long time behind a slow one ahead of it,
  with no progress update of its own the whole time because it hasn't started
  yet. Reaping it on the same clock used to mark it "failed" purely for
  waiting its turn, and then `drain()` ran it anyway once its turn came,
  flipping the status right back — a business saw a job randomly un-fail
  itself. A `queued` row is instead checked against the in-memory `queue`
  array: still present means the process is alive and it's genuinely waiting;
  absent (a restart wiped `queue` back to empty) means it's truly orphaned.
- **Typed text stays synchronous.** It is fast, and someone who just clicked Save
  expects the document to be there.
- **A running job can be cancelled** (§6.14), and **a failed one retried**
  without re-uploading (§6.15).

⚠️ In-process queue. Before scaling out, move it to BullMQ/Redis; only `jobs.js`
changes.

### 6.7 Only text documents are editable

`isEditable()` in [`extract.js`](src/lib/agent/extract.js): typed text, `.txt`,
`.md`. **Not** PDF, DOCX, CSV or crawled URLs.

What is stored for those is text we *extracted*, and extraction is lossy —
layout and tables are gone. An edit box would present our approximation as if it
were their file, and the next re-upload would silently discard their edits.
Replace (upload again) and delete are the honest operations. Renaming stays
allowed: a title is ours, not the file's.

**Enforced in BOTH places** — the console hides the button and
`PUT /api/knowledge/:id` returns 409. A hidden button is not a permission check.

### 6.8 Native document libraries must stay unbundled

`serverExternalPackages` in `next.config.mjs` lists `pdfjs-dist`, `mammoth`,
`tesseract.js`, `@napi-rs/canvas`.

pdfjs resolves its worker at runtime; bundled, that path is rewritten to
something that does not exist and **every PDF upload fails** with "Setting up
fake worker failed". `@napi-rs/canvas` ships a native `.node` binary Turbopack
cannot place at all. All four are imported lazily, so a tenant who never uploads
a scanned PDF never loads the OCR stack.

### 6.9 Crawled URLs are hostile input

[`crawl.js`](src/lib/agent/crawl.js) fetches addresses a tenant types, which
makes a naive implementation a **Server-Side Request Forgery**: type
`http://169.254.169.254/latest/meta-data/` and the server fetches cloud
credentials and stores them as "knowledge" the tenant reads back by asking their
own agent.

Not optional, not to be simplified:
- **https/http only**, and the resolved **IP** is checked against private,
  loopback, link-local and reserved ranges — decided on the address, not the name.
- **Redirects followed manually** and re-validated at every hop. A public
  hostname can redirect to `127.0.0.1`; checking only the first URL misses it.
- **Redirects are also pinned to the origin that was actually requested.**
  Re-validating the SSRF blocklist at every hop stops a redirect landing on a
  private address, but says nothing about a redirect to a different PUBLIC
  site — an open redirect (or an ad tracker) could hand the crawler off to an
  unrelated domain and it would get ingested as if it were the business's own
  content. `fetchPage` now rejects a hop whose origin differs from the one it
  started with (`reason: "crossOriginRedirect"`).
- **The TCP connection is pinned to the exact address `checkUrl()` validated —
  not left to `fetch()` to re-resolve.** Global `fetch()` is `undici`
  underneath, and by default it does its OWN DNS lookup when it actually
  connects, moments after ours. That gap is a DNS-rebinding hole: a hostile
  authoritative DNS server can answer our check with a safe public IP and
  `fetch()`'s with `127.0.0.1` or a cloud metadata address. A per-hop `undici`
  `Agent` with a custom `connect.lookup` forces the real connection to the
  checked address, closing the gap. **Must import `fetch` from the `undici`
  package itself, not use the global one** — mixing a global-`fetch` request
  with a separately-installed-`undici` `Agent` fails outright
  (`invalid onRequestStart method`) because the two copies' internal Request
  shapes don't match.
- Size-capped, time-capped, bounded page count, HTML/text only.
- **Same-origin links only.** A business asked us to read THEIR site.

**Judged on the address's numbers, not its spelling (tests/crawl.test.mjs).**
`isBlockedAddress` parses IPv6 into eight groups: `::ffff:127.0.0.1`,
`::ffff:7f00:1` (the form `new URL()` actually produces), NAT64, 6to4,
IPv4-compatible, all of fe80::/10, site-local and multicast are blocked by their
embedded IPv4 / prefix. `checkUrl` strips the brackets from `[::1]` before
`isIP`: before, an IPv6 literal fell through to a DNS lookup of the string
"[::1]" (blocked only by accident, and a public IPv6 literal could never be
crawled); stripping them without the hex-mapped handling would have OPENED a hole,
so the two travel together. `htmlToText` no longer throws on an out-of-range
numeric entity (`&#99999999999;` made `String.fromCodePoint` abort the crawl).

Verified refused: cloud metadata, `127.0.0.1`, `localhost`, `10.x`, `192.168.x`,
IPv6 loopback, `file://`, a redirect to a different public origin, a redirect
to a private address on the second hop.

One document per SITE so a re-crawl is an ordinary replace. **The starting page
is exempt from the thin-page filter** — the business typed that address
deliberately.

### 6.10 Knowledge is REPLACED, never appended

A document is a `knowledge_sources` row; chunks hang off it with
`onDelete: Cascade`. Ingesting a title that already exists **deletes its old
chunks in the same transaction** that writes the new ones.

Ingest used to be insert-only: a business that corrected a price and re-uploaded
ended up with both versions competing, and the agent sometimes quoted the price
they had just fixed. **Never reintroduce an append-only path.**

- **Embed BEFORE deleting.** If the model is down, the previous version keeps
  answering instead of the business being left with nothing.
- **`content` is the original text.** Chunks are rebuilt from it, so re-chunking
  needs no re-upload.
- **A rename does not re-embed** — it rewrites the denormalised `sourceTitle`.
- **A REPLACE re-embeds only chunks whose text changed (§6.21).**
- **A RE-EMBED (`npm run reembed`, §6.2) follows the same rules, from the stored
  `content`** — no re-upload, no Cloudinary. It embeds ALL of a document's chunks
  first and swaps them in one transaction, so a quota stop or crash leaves the
  document answering from its old chunks, never with none (verified: a failure on
  batch 2 of 3 left every old chunk id in place). **It must NOT bump
  `updated_at`**: that date is what the conflict rule uses to decide which of two
  disagreeing documents is newer, and a re-embed is not an edit — so it writes the
  scheme and chunk count with raw SQL, because Prisma's `@updatedAt` only fires
  through the client. If the document is edited while it embeds, the swap is
  skipped (the edit's own ingest already used the current scheme).

**The row itself must roll back on failure, not just the chunks.** The upsert
that marks a document "processing" happens BEFORE chunking/embedding, writing
the NEW content/metadata onto the row immediately — but the old chunks aren't
touched until the whole embed succeeds. Left alone, an ordinary failure (a
quota error, a chunk-count limit) used to leave the row **displaying the new,
never-embedded text while retrieval kept answering from the old chunks** — a
business corrects a price, the save appears to go through, and the agent
keeps quoting the old number with no visible sign anything is wrong.
`ingestDocument`'s catch now restores every field to the pre-attempt row
(content, `fileName`, `fileUrl`/`filePublicId`, `status`, `error`) whenever a
REPLACE fails or is cancelled — a brand-new document with no prior version
still gets the old behaviour (a visible "failed" row), since there's nothing
to roll back to.

**The console confirms before replacing.** Same-name-replaces was always the
right server rule (see below), but nothing stopped it firing on an accidental
name collision. Upload, write and crawl each check the title against the
already-loaded document list client-side and prompt ("X already exists and
will be replaced. Continue?") before submitting — a UX courtesy, not a second
security boundary; the server still enforces the real rule regardless of what
the client checked.

**Known limitation:** replace fixes duplicates *within* a document. Two different
documents that disagree is a separate problem — retrieval passes each source's
last-updated date and the prompt has a conflict rule, so the agent surfaces the
discrepancy rather than silently picking. Observed and fixed after a corrected
price lost to a stale one in another file.

**The conflict rule, second version (`prompt.js`) — it used to say "prefer the newest and
mention it", and that was the bug.** Retrieval was fine; the prompt was not. Rebuilt offline
from the stored chunks of test-docs 03 and 08 (no model call), the old prompt showed:
(1) a rule that told the model to PICK the most recent source, with "mention the discrepancy"
as an afterthought — so a reply could comply with the rule and still give one number;
(2) recency that cannot decide, because both documents were updated on the same day
(2026-09-29, eight seconds apart); (3) labels `(source: …)` that never said these were
different documents, so 179 once against 149 twice read as a majority vote.
Now:
- Passages are labelled `[1] (document: "storepulse price list", section: Pro Plan, updated
  29 September 2026)`. Document names are humanised (no number prefix, extension or hyphens —
  a first live run read `08-storepulse-price-list-conflict` aloud) unless two documents would
  collapse to the same name; dates are "29 September 2026" in fixed English month names and
  UTC, not ISO. When the passages come from 2+ distinct documents a `NOTE: these passages come
  from N DIFFERENT documents` line precedes them.
- The rule `IF DOCUMENTS DISAGREE` is included ONLY for 2+ distinct documents (two passages of
  one document are not a disagreement between sources), is the LAST section of the prompt
  (after the reference block, the grounding rule and the profile exception), is three
  sentences, and has no markdown, digits or file names: give BOTH values, name each document by
  its plain name and its date, offer to have the team confirm, "never average"; recency may be
  mentioned but is no longer a tie-break; "if the documents give the same value, say nothing
  about documents or any discrepancy".
- 22 assertions pin it (tests/prompt.test.mjs): gating, wording, position, sentence count,
  voice-safety, identical on chat and voice, labels, the NOTE, date format, name collisions.

**Verified with 9 real chat calls** (`scripts/chat-probe.mjs`, tenant `retest-conflict`, a
hard cumulative budget of 10 enforced by a counter file). Baseline with the OLD prompt (2 calls):
both languages did mention a discrepancy and both prices — but named no document and no date.
With the new prompt, final run: EN "How much is StorePulse Pro?" → *"…Our 'storepulse price list
conflict' document updated on 29 September 2026 lists it at 179 euro per month, while our
'storepulse pricing plans' document updated on the same date lists it at 149 euro/month. Would
you like us to have our team confirm…"*; IT → both prices, both documents, "29 settembre 2026",
offer to confirm; the non-conflict question (Lite, 59 in both) → one price, no discrepancy; the
off-topic question → declined, no sources. **Honest limits of that evidence:** one sample per
question on a non-deterministic model — the original failure was "sometimes", so this shows the
new wording CAN produce the right reply, not that it always does; the Lite reply still cited
both documents by name and date ("according to both…") when asked for a price they agree on,
which the last clause asks the model not to do (harmless, but not fully obeyed); and the
fixture's two documents carry the same date, so "which is newer" was never exercised.

### 6.11 The model never silently mutates tenant data

`TOOL_EXECUTION_AVAILABLE` in `prompt.js` is **`false`**. Capabilities flagged
`requiresTool` are described to the model *plus* a hard guard: gather details,
promise follow-up, never claim completion, never invent a reference number.

A model told "you can book appointments" with no tool behind it will confidently
reply "you're booked for Tuesday at 3" — a plausible lie to a real customer.
Flip the flag only **after** tools genuinely execute, and log every executed call
to `agent_actions`.

**The console's capability toggles are hidden from the UI for the same
reason** (`SHOW_CAPABILITIES = false` in `page.js`) — showing switches for
things the agent can only ever describe, never do, invited confusion about
what flipping them actually changes today. This is a display choice only:
`config.capabilities` and `toggleCapability` are untouched, so re-enabling it
when tools genuinely execute needs no migration, just flipping the flag back.

### 6.12 API routes always return JSON

Wrap handlers in try/catch and return `NextResponse.json({ error }, { status })`.
An uncaught throw sends an empty body and the client sees "Unexpected end of
JSON input" instead of the real cause.

**`return someAsyncHandler(...)` inside the try block is NOT the same as
`return await someAsyncHandler(...)`.** `knowledge/route.js`'s `POST` handler
did exactly this for `handleUploads`/`handleCrawl`/`handleTypedText` — the
`try` block "succeeds" the instant it returns the pending promise, so a
REJECTION from that promise settles later, after `catch` has already exited,
and escapes as an unhandled rejection instead of being formatted as JSON. This
produced precisely the empty-500 failure mode above for something as ordinary
as a too-large document. Every handler that can throw asynchronously must be
awaited before `return`, even one line above the `catch`.

### 6.13 Cloudinary stores the original file, never what the agent answers from

[`storage.js`](src/lib/agent/storage.js) uploads an uploaded document's raw
bytes (`resource_type: "raw"`) purely so a business can get its original file
back and so deleting/replacing a document also removes the copy sitting in
Cloudinary. It has nothing to do with retrieval — `content` (extracted text,
already in Postgres) is what the agent answers from regardless of whether
Cloudinary is even configured.

- **Best-effort, always.** `uploadOriginalFile`/`deleteOriginalFile` never
  throw — a Cloudinary outage must not fail an otherwise-successful import,
  and a failed delete must not block removing the document or its vector
  data. Postgres is the source of truth for whether a document exists;
  Cloudinary never is.
- **The OLD file is deleted only after the NEW version is fully committed** —
  inside `ingestDocument`, after the chunk-swap transaction succeeds, never
  right after the upsert. Deleting it any earlier risks a failed or cancelled
  replace leaving the row with no original at all, for either version.
- **A cancelled or failed replace restores the OLD `fileUrl`/`filePublicId`**
  onto the row (see §6.10) and deletes whatever the NEW, now-abandoned
  attempt had already uploaded — never the reverse.

### 6.14 Job cancellation is cooperative, and the writer owns the rollback

A running job (`lib/agent/jobs.js`) can't be stopped mid-`await` — `run()` is
a plain async function, not a cancellable operation. `cancelJob()` only
records the request (`cancelledJobIds`); the job's own next progress
checkpoint (`JobContext.report`, called once per page fetched, OCR'd or BATCH of
16 chunks embedded — checked BEFORE the batch's request is spent, so a cancelled
job never pays for another batch) notices and throws `JobCancelledError`, unwinding out of
`crawlSite`/`ocrPdf`/`ingestDocument`.

- **A queued job is removed from the in-memory array immediately** — nothing
  was ever written for it, so there's nothing to roll back.
- **`ingestDocument` — not `cancelJob` — owns cleaning up whatever a running
  job had already written**, because it's the only place that knows whether
  this was a brand-new document (delete the row + any Cloudinary upload) or a
  replace (restore the old row, see §6.10 and §6.13). `cancelJob` itself never
  touches the document row.
- **`ocrPdf` and `crawlSite` must let `JobCancelledError` propagate, not
  swallow it as an ordinary failure.** Both wrap their work in a broad
  try/catch that used to catch everything indiscriminately; a cancellation
  arriving through their `onProgress` callback needs an explicit
  `if (err instanceof JobCancelledError) throw err;` before the generic
  catch, or it gets reported as "unreadable"/a crawl failure instead of being
  recognised and cleaned up as a cancellation.
- **`cancelJob()` must not claim "cancelled" before confirming the job hasn't
  already finished.** A black-box test sweep cancelled a job immediately after
  starting it, got back `status:"cancelled"`, then polled a moment later and
  found `status:"done"` for the SAME job id — data integrity was fine (no
  duplicate/orphan rows), but the DELETE response itself had lied. Root cause:
  a small/fast job can run PAST its last `report()` checkpoint — nothing left
  ahead of it to throw `JobCancelledError` — while `cancelJob()`'s own
  unconditional write ("cancelled") and `drain()`'s completion write ("done")
  race for the same row, and `drain()`'s write is not conditioned on the
  other, so it always wins a moment later regardless of what `cancelJob()`
  already told its caller. `jobSettlers` (a `Map<jobId, Promise>`) fixes this:
  `drain()` creates an entry when a job starts and resolves it with that job's
  OWN final row the instant it reaches "done" or "failed" (or `null` on a
  genuine `JobCancelledError`). `cancelJob()`, for a job already processing,
  races that promise against a short bounded timeout (300ms) before writing
  "cancelled" itself — if the settler resolves first, it means `drain()` won
  the race, so `cancelJob()` returns the REAL row instead of a stale claim. A
  genuinely long-running job is not kept waiting: the timeout loses that race
  by design, and cancellation proceeds exactly as before. Verified against the
  live race by importing this exact module with a stub DB and controlled
  timing — a job cancelled after its last checkpoint reports "done" (not
  "cancelled"), and a job cancelled before its next checkpoint still throws
  `JobCancelledError` and reports "cancelled", unchanged.
- **A second, narrower window of the same race** (found by tests/jobs.test.mjs,
  pinned there): the row `cancelJob` reads at the top can be stale — a job that
  finishes during that read has no settler left, and the final write was an
  unconditional `update`, overwriting a completed import with "cancelled". It is
  now `updateMany` conditional on `status in (queued, processing)`, followed by a
  re-read; if it matched nothing the request is also cleared from
  `cancelledJobIds`.

### 6.15 A failed import can be retried without re-uploading

`retrySource()` re-embeds a document whose LAST attempt failed, using what's
already on the row: `content` was saved before embedding was ever attempted
(§6.10), and the Cloudinary reference (§6.13) was never touched by the
failure. A retry therefore never re-reads an uploaded file or hits Cloudinary
again — it re-runs chunking + embedding through the same `ingestDocument`
every other ingest uses, which is what gives it the same rollback and
cancellation behaviour for free. Passing the row's OWN `fileUrl`/`filePublicId`
back in as `file` matters: omitting it would make `ingestDocument`'s upsert
write `fileUrl: null`, silently orphaning the Cloudinary asset.

**Only offered in the console for TRANSIENT failures** (quota, a provider
outage — `isRetryableError` in `page.js`). A document that failed because it's
genuinely too large, or produced no chunks, will fail again identically no
matter how many times it's retried; showing the button for those would just
train people to click something that can never work. `POST
/api/knowledge/:id/retry` re-checks `status === "failed"` itself rather than
trusting the client's classification.

### 6.16 User-facing errors must never leak provider internals

A Gemini quota error's `.message` is a multi-line JSON blob — status codes,
doc links, a retry countdown. Stored and logged verbatim (useful for
debugging), but a business or a customer must never see it raw: it happened
once, showing a `RESOURCE_EXHAUSTED` JSON dump next to a failed upload instead
of "The AI service is at its usage limit for now."

`humanizeError()` in `page.js` classifies a raw message before display —
known technical signatures (quota, network/`ECONNREFUSED`) map to a
translated, friendly sentence; our OWN thrown Errors (short, brace-free
English like "Document is too large: 420 sections, limit 400") pass through
untouched; anything else technical-looking falls back to a generic translated
message. Applied everywhere a raw error could reach the screen — job
failures, document failures, save/upload/crawl/chat errors — never only in
one place, or the next one added will leak again.

### 6.17 Conversation history is the MOST RECENT N messages, not the first N

`respond.js` bounds how much of a conversation it sends to the model —
`MAX_HISTORY_MESSAGES = 20` — because an unbounded history eventually blows
the context window and the per-turn bill. **The query that enforces that
bound MUST sort newest-first before `take()`, then reverse in JS** —
`orderBy: { createdAt: "asc" }, take: 20` (the original code) takes the
OLDEST 20 messages instead. Once a conversation passes 20 messages that
window stops moving at all: the model is shown the same early-conversation
slice forever, and — this is the sharper failure, confirmed live rather than
assumed — **the customer's live question is not in it**, because step 1
always persists that message first and it is therefore always the NEWEST row
in the table. Depending on where the fixed 20-message window happens to end,
Gemini either answers from stale context with no idea a new question was
asked, or (when the window ends on an assistant turn — see below) rejects
the request outright: `400 Requests ending with a model turn are not
supported`. Reproduced exactly by seeding a 30-message conversation and
replaying the buggy query before fixing it — this is not a theoretical edge
case, it is guaranteed to happen to every conversation that runs long enough,
and it gets WORSE the longer the conversation continues past the limit, not
better. Fixed with `orderBy: { createdAt: "desc" }, take: 20` followed by
`.reverse()` — same bound, but the newest 20, back in chronological order.

**A window into the middle of a longer conversation needs two more guards
that a window starting at message 1 never did:**

- **A leading "model" turn is trimmed.** Once history no longer starts at
  message 1, it can start on either role — roughly half the time on an
  assistant reply, since turns alternate. Verified live against the real
  Gemini API that this does not error (the model just answers past it), but
  it is a turn with no question attached, so it is dropped rather than kept
  on the strength of undocumented tolerance across model/provider versions.
- **Consecutive same-role turns (e.g. two "user" turns when an earlier reply
  failed before persisting its half) are left AS-IS, not merged.** Verified
  live — both synthetically and by hitting this exact situation for real
  after a failed call left an orphaned user turn — that neither Gemini nor
  OpenRouter's OpenAI-style dialect require strict alternation. Merging would
  invent a turn structure that never happened, to solve a problem that,
  tested, does not exist.

**The conversation-locale read/write (step 4) is folded into the same
`Promise.all` as config and history, and its write is fire-and-forget.**
(Retrieval used to be in that block too; it now runs right after, because it
needs the history to resolve a follow-up — §6.19.)
It doesn't depend on the other two, so querying it serially after
them was pure added latency for no reason; and the write is a transcript
label nothing downstream reads back, so it doesn't need to block the reply
either — the same "must never break the work it's reporting on" reasoning
`jobs.js` already applies to progress writes (§6.6).

### 6.18 The tenant seam and the rate limiter existed but were never wired up

Two enforcement points were written, documented, and never actually called:
`assertTenantServiceable()` (§4) claimed in its own comment to be "already
called on the paths that matter" — it had zero callers. `hit()` in
`lib/security/rate-limit.js` had zero callers too, so `/api/chat` had no
throttle at all, despite every message costing an embedding call plus a
generation call against a shared, scarce quota (limitation #3). A suspended
tenant would have kept being served; a runaway script could have exhausted
that quota for every tenant in minutes.

**Fixed with one shared, translated wrapper, not six copies of tenant-state
logic.** `requireServiceableTenant({ tenantId, tr })` in `registry.js` is
what every route calls — never `assertTenantServiceable()` directly — and it
is now called from `/api/chat`, all of `/api/knowledge` (the POST covering
upload/crawl/typed-text, `PUT`/`DELETE` on one document, and the retry route),
and `agent-config`'s `PUT`. Deliberately NOT called from any `GET` (reading a
suspended tenant's own data isn't the failure mode `assertTenantServiceable`
guards against) or from the job-management routes (cancelling an already-
permitted background job isn't a new grant of service). It translates by the
verdict's STATUS CODE, not by matching `assertTenantServiceable()`'s raw
`error` string — so the one function §4 says to edit can gain new reasons
without this wrapper, or any of its callers, needing a matching edit.

**The same wrapper is also where tenantId's SHAPE is enforced**
(`^[A-Za-z0-9_-]{1,100}$`), because `tenantId` was an unvalidated query param
flowing into a Cloudinary folder path built by string interpolation —
`storage.js`: `` `caller-ai-agent/${tenantId}` ``. Verified directly against
Cloudinary, not assumed: a `tenantId` containing `..` is rejected by
Cloudinary's OWN `public_id` validation (`public_id (...) is invalid`), but a
tenantId containing a plain `/` is NOT rejected — `caller-ai-agent/victim/
nested-by-attacker` landed exactly there, confirmed via the upload result's
`asset_folder`. The charset restriction closes that categorically, before the
value ever reaches `storage.js`.

**`/api/chat` also gets `/api/knowledge`'s upload path (§6.12) applied to
itself: a hard upper bound on input size, and the two-layer rate limit
`rate-limit.js`'s own header comment already described but nothing called.**
- `MAX_MESSAGE_CHARS = 4000` — generous for a typed question, but stops
  "message" being used to smuggle a large document in outside the normal
  upload path.
- `TENANT_LIMIT` (60/min) and `CONVERSATION_LIMIT` (5/10s) — the tenant layer
  is loose on purpose (a busy business has several conversations at once);
  the conversation layer is tight, because no real person reads a reply and
  replies again in under two seconds. Verified live with both layers
  temporarily lowered (to keep the free-tier chat quota cheap to spend on
  testing): the 3rd rapid message to ONE conversation tripped the
  conversation limit, the 4th (a fresh conversation, same tenant) tripped the
  tenant limit — each a `429` with a correct, distinct `Retry-After` header
  and a translated JSON body, restored to their real values immediately
  after. Both live inside `chat/route.js`, not `rate-limit.js` — the limiter
  is a generic mechanism, the numbers are a decision specific to this traffic
  shape and do not belong as a shared default (telephony will need its own).
- `MAX_FILES_PER_UPLOAD = 20` on `/api/knowledge`'s multipart path — one job
  per file all lands in the SAME queue (concurrency 1, §6.6), so an
  unbounded file count in one request could queue hundreds of jobs ahead of
  every other tenant's next upload.

**Explicitly NOT built here: billing, plans or quotas.** That is the
partner's, per §4. This is only the enforcement POINTS — the seam calling
`assertTenantServiceable()`, and a mechanism protecting shared quota from
abuse — not a metering system.

### 6.19 A follow-up is searched as the question it really is — and only a rewrite can tell a follow-up from a new topic

`respond()` used to retrieve with the raw latest message. "And the Growth
one?" has no standalone meaning: embedded alone it lands on whatever chunk
is nearest to nothing in particular — the support-hours doc at 0.395 — or
clears no threshold at all, and the agent says "I don't know" about the thing
it was literally just discussing. On a call most turns after the first are
this shape. Measured (`eval:real`, 16 follow-ups each carrying the
conversation before it, topK 5): **31% hit@1 (5 of 16)**; 8 of the 11 misses
returned nothing at all and the other 3 the wrong document.

**Three strategies were measured against the same 16 follow-ups plus 7
off-topic questions asked mid-conversation** (`--strategy=raw|concat`, and the
default `rewrite`; code in [`query.js`](src/lib/agent/query.js)):

| Strategy | Follow-ups hit@1 | Off-topic mid-conversation rejected | Cost |
| --- | --- | --- | --- |
| `raw` (the old behaviour) | 31% | 7/7 (trivially — it never looks at the history) | none |
| `concat` (previous question + this one) | 100% | **0/7 — every one leaked** | none |
| `concat`, no empty-first-pass fallback (derived from the same run) | 94% (15/16) | 4/7 — the 3 SHORT ones still leaked | none |
| **`rewrite` (LLM → standalone query)** | **100%** | **7/7** | one model call per triggered turn |

**Why concat loses despite being free and 100% on follow-ups: it cannot tell a
follow-up from a new topic.** "What about the weather?" after a pricing
question becomes "How much is the Growth plan? What about the weather?", which
retrieves the Growth FAQ at 0.386 and hands the model a price list to answer a
weather question from — the exact failure §6.3's threshold exists to prevent,
reintroduced through the front door. Dropping the fallback doesn't fix it: the
cheap trigger fires on short messages, and short off-topic messages are what
callers say. Only a step that can JUDGE "this is a new topic, leave it alone"
is safe, which is what the rewrite prompt's "return it EXACTLY as written"
clause is for — the model returns the four long off-topic questions and the
three short ones unchanged, and nothing is retrieved. (The same check protects
against the rewrite inventing facts: its instruction forbids adding any price,
number or product the customer never mentioned, because a rewrite is a search
key, not an answer, and a bent query is invisible to the grounding rule
downstream. It must also keep the customer's language — Urdu stays Urdu;
prompt text is in `prompt.js`.)

**When a model call is spent (`retrieveForTurn` in `query.js`), in order:**
1. No earlier turns → search the message as typed. A first message can't be a
   follow-up.
2. `needsContext(message)` → rewrite BEFORE searching: it opens with
   "and/but/what about/e/ma/anche…", or points back with "that/it/them/the Pro
   one/quello…", or is four words or fewer and not obviously complete (a short
   message that addresses the business, names a brand or is "what does X do" is
   not rewritten — see the latency list below) (English, Urdu script and Roman Urdu; the two
   active languages, §7). Pure regex, free.
3. Otherwise search as typed, and only if that returns NOTHING (and the message
   isn't a pleasantry like "thanks"/"grazie") rewrite and search again — the
   net for follow-ups the cheap check missed. A message that already retrieves
   fine never pays for a call.

**The rewrite fails SOFT and is bounded.** It goes through `llm.js`
(`generateReply`, same provider fallback) like every other model call, has a
hard 3-second budget (`REWRITE_TIMEOUT_MS`), and on ANY error, timeout or
unusable output searches the raw message — a reply is never lost to an
optional search-quality step. Retrieval's gate is untouched: `MAX_DISTANCE`
still alone decides what the model sees (§6.3); only the query changed.
`respond()` returns `searchQuery` (when it differs from what was typed) and
`rewriteStatus`; the test console shows "Searched for: …" and, if a rewrite
failed, says so — so a silent fallback is visible to a human.

**What it costs — be honest about this one, it collides with §9.2.** A rewrite
call took ~0.85–1.0s when the provider was healthy, 1.3–1.5s on average across
a paced 23-turn run (slowest ≈ 2.9s). In degraded stretches (the free-tier
Gemini pool is flaky; seen several times while building this) it was far
worse — **15 of 23 calls hit the 3s budget in one run, and in another, with
the budget raised to 15s, two calls simply hung** — and those turns fell back to raw (accuracy back to the 31%
baseline, replies unaffected — the fail-soft contract holding under real
stress). That is added to EVERY triggered turn, before generation even starts,
against a voice budget of ~800ms to first audio (§9.2). **Four things now cut it;
none of them has been measured against a real provider** — everything below was
verified with stubbed models and a fake clock, which proves the logic and the
arithmetic, not the milliseconds.

1. **Fewer needless calls — the trigger is more precise** (`npm run eval:trigger`,
   regex only). It fired on 10 of 71 standalone questions (the "8 of 64" above, counted
   before off-topic items were included); now 1 of 71, and it still fires on 15 of the
   16 genuine follow-ups. Precision 60% → 94%, recall 94% → 94%. The rules, each a
   fix for a specific false positive: a SHORT message (≤4 words) is a complete
   question when it addresses the business ("who are you", "what's your ragù recipe"),
   names a brand or carries a number ("Is Pro included?"), or is the "what does X
   do/about" overview opener; "this" points back only as a pronoun or before a generic
   noun (not "what's this new connect thing"); "there" only at the end of a message
   (not "is my info still there"); "the pro one" only in a message of ≤10 words.
   **Deliberately NOT done:** the business-noun exemption ("price", "refund",
   "shipping" make a short message standalone). Measured: it removed no further false
   positive and dropped a real follow-up ("Who pays for shipping?") — recall matters
   more, because a missed follow-up is only rescued by the empty-first-pass net when
   the raw search returns NOTHING, not when it returns something wrong. Still fires,
   by design: "what do you guys charge for the pro one" (an ambiguous back-reference
   that the set labels standalone) and 3 of 7 new-topic turns ("What about the
   weather?" — no text rule separates it from "What about Sundays?"; the rewrite
   returns it unchanged). **Caveat:** tuned on these 94 questions; read it as
   "principled and fits the set", not as a live rate. Re-run it when questions are added.
2. **A failing provider no longer costs 3s a turn — the circuit breaker**
   (`breaker.js`, used by `generateRewrite` in `llm.js`). After
   `REWRITE_BREAKER_THRESHOLD = 3` consecutive failures or timeouts the rewrite is
   skipped for `REWRITE_BREAKER_COOLDOWN_MS = 60_000`: the call is refused instantly (0ms,
   the provider is not called), `rewriteQuery` returns status `"skipped"`, the raw
   message is searched, and the test console says rewriting is paused. After the
   cool-down exactly ONE probe is let through (concurrent turns are refused while it is
   in flight); success closes the circuit, failure re-opens it for a full new
   cool-down. A 400/422 (our own bad request) neither opens it nor resets the streak;
   a 429, 5xx, network error or timeout counts. In-process state (§8 limitation 9).
   The 15-of-23-timeouts stretch above would have cost ~3 timeouts, then ~0.
   A timed-out call is ABANDONED, not cancelled — it keeps running (and retrying inside
   `withRetry`) and may still spend quota.
3. **A dedicated, faster model for the rewrite** — `GEMINI_REWRITE_MODEL` (and
   `OPENROUTER_REWRITE_MODEL`), documented in `.env.example`. Unset = the chat model,
   so behaviour is unchanged. Read per call by provider (`rewriteModelFor`), so the
   fallback provider uses its own. On the Gemini free tier a separate model also has
   its own daily quota. **Nothing has been evaluated with a smaller model**: it must
   follow the "ONE line, no explanation, keep the language, never add facts" prompt, and
   the only way to know is `npm run eval:real` (followup 100% / followup_offtopic
   rejected) with the variable set.
4. **Speculative raw search — built, OFF** (`SPECULATIVE_RAW_SEARCH` in `query.js`).
   Starts the raw-message retrieval together with the rewrite and uses it when the
   rewrite comes back unchanged / failed / skipped, or does not answer within
   `SPECULATIVE_REWRITE_BUDGET_MS = 1500` (the rewrite gets that budget instead of 3s,
   since the raw result is already in hand). The trade, with the fake-clock test numbers
   (rewrite 1000ms, search 400ms): rewrite UNCHANGED/FAILED → 1000ms instead of 1400
   and no extra cost; rewrite CHANGED the query → still 1400ms (the rewritten query
   must be searched after the rewrite returns) **plus one embedding text spent and
   thrown away**. Every genuine follow-up is the second case (all 16 in eval:real), so
   on the turns that need the rewrite it is a pure cost — 2 embedding texts instead of
   1 against a ~1000/day quota (§6.20) — and a latency win only on turns that did not
   need it, which the trigger work above already made rare. It is NOT the fix for real
   follow-ups; a faster rewrite model is. Leave it off unless a measurement of real
   rewrite latency says the unchanged/failed fraction is large.

**Still needs a real measurement** (needs a working provider and, for `eval:real`,
quota): the rewrite's latency with and without `GEMINI_REWRITE_MODEL`; what fraction of
live triggered turns come back unchanged/failed (that decides whether speculation pays);
the right `SPECULATIVE_REWRITE_BUDGET_MS`; whether a smaller model holds the 100% /
7-of-7 follow-up numbers. The ~0.3–0.5s for one search is an estimate, not a timing.

**Not fixed by this: generic overview openers still score 0% hit@1.** "Who
are you" is not a follow-up — there is no earlier turn to rescue it. That is
§6.20's problem and §9.1's open item.

**Measuring it.** `eval:real` scores `followup` and `followup_offtopic` against
the saved baseline like every other category. Three things about the harness
exist because of how this went wrong: (1) rewrite turns are PACED at ~13 per
minute — the free tier caps chat requests per MINUTE, a burst of 20 trips it,
the provider's retry backoff pushes calls past the 3s budget, and the run
measured the rate limiter instead of the strategy; (2) a turn whose rewrite
FAILED is re-issued twice, and a run that still has failures is reported
`INVALID` and never compared or saved — otherwise the fallback-to-raw turns
read as "rewrite doesn't help" and silently poison the baseline; (3)
`--strategy=` runs are exploratory and never read or write the baseline; (4) the eval gives
the rewrite a 15s budget (`rewriteTimeoutMs`, debug route only — respond() never
passes it) so it measures the strategy's QUALITY, and counts separately how
many calls exceeded the production 3s budget, so latency can't masquerade as a
quality result.

**Honest state of the saved baseline.** It was captured on a clean run (0
failed rewrites: follow-ups 16/16, off-topic 4/4). The three SHORT off-topic
turns were added afterwards; they came back unchanged and un-leaked (7/7) in
two later runs, but those runs also had unrelated rewrite timeouts, so the
harness (correctly) refused to save them and the baseline still says
`followup_offtopic` n=4. Re-run `npm run eval:real -- --update-baseline` when the
provider is healthy to fold them in. The baseline gate is a rate, so it is
not loosened in the meantime.

### 6.20 "Who are you?" — the profile answers it; retrieval still cannot

The most common opening question on a call ("tell me about your company",
"what do you do") is declined (TEST-REPORT §4). Two separate things fail, and
only one is fixed.

**Measured cause — raw cosine distance to the nearest chunk, `__eval_real__`
corpus, gate 0.43:**

| Question | Nearest chunk | Best chunk of `01-company-overview.md` |
| --- | --- | --- |
| what type of services you provide | 0.432 · CSV fragment (untitled) | 0.487 |
| give me overview about your company | 0.446 · CSV fragment | 0.484 |
| tell me about your company | 0.468 · CSV fragment | 0.489 |
| who are you and what do you sell | 0.442 · CSV fragment | 0.479 |
| what do you do | 0.462 · recipe "Notes" | 0.504 |
| who are you | 0.494 · refund "Support Contact" | 0.520 |
| what products do you offer *(passes)* | 0.394 · the Products chunk | 0.394 |
| what does nyron do *(passes, has the brand)* | 0.299 · refund policy | 0.306 |

Three things this settles. (1) **Hypothesis (a) is only half right.** The
untitled CSV fragment is the nearest chunk for 4 of the 6 failing phrasings, but
the About/Products chunk itself sits at 0.48–0.52 — 0.05–0.09 OVER the gate — so
re-ranking the CSV away would still return nothing. (2) **(b) is confirmed**: a
generic question has no anchor, so every chunk is equally far (0.43–0.49); the
nearest one is noise, not the answer. (3) **(c) was real but partial**: the
purpose was already in the identity line, and a rich purpose let the old prompt
answer most phrasings from it — but inconsistently (one phrasing, "give me
overview about your company", was flatly declined), and with no purpose
configured there was nothing to answer from. Raising `MAX_DISTANCE` is ruled
out as always: the closest off-topic question is 0.397 (§6.3).

**Fixed — an always-available business profile (`prompt.js`).** An `ABOUT THIS
BUSINESS` block (name, purpose, hours — only what the owner typed; the old
`BUSINESS HOURS` section is folded into it, same rule) sits in every prompt,
and the grounding rule gets ONE narrow exception: answer who-you-are,
what-the-business-does and hours from it, restate only what it says, never turn
it into products/prices/locations, and don't guess a description from the
business's name. Placeholder name + empty purpose → no block and no exception
(`PLACEHOLDER_BUSINESS_NAME` in `tenant/config.js`). Checked against the real
prompt and real model with retrieval results supplied directly (embedding quota
was exhausted — see below), purpose = "We build business software for clinics
and retailers…": flat declines of the 9 declined phrasings went from 1 to 0;
"who are you / what do you do / tell me about your company" now answer. It does
NOT enumerate products (the profile does not name any) — "what do you sell" /
"what services" restate the purpose and offer a hand-off, which is correct.
Invention checks: "How much does Nyron Connect cost?" with the real chunk →
declines (unreleased, no pricing); "Platinum plan price", "what products and
how much" with a thin profile and no chunks → decline; off-topic → no answer
from the profile; hours → "closed Saturdays", "open Monday 09:00–18:00" as
configured. One leak found and closed: with a name and NO purpose the model
said "we provide software solutions", inferred from "Nyron Software
**Solutions**" — hence the "don't guess from the name" clause.

**BUILT — the business summary: written by the AI from documents the owner CHOSE, approved by the owner, always
in the profile** (`lib/agent/profile-summary.js`, `summary-rules.js` pure; per agent: `agent_configs.profile_summary`
+ `profile_summary_sources`, migration `20261027120000_agent_profile_summary`, hand-written, HNSW line removed). The
owner ticks the documents that describe the business (Knowledge tab → "Summarize for the agent", recommended by a
hint until the agent has one; ≤10 documents), ONE model call (`POST /api/agent-config/summary`, 6/min per tenant,
saves NOTHING) writes ≤120 words of general facts (`prompt.js buildSummaryInstruction`: who, what, kinds of products
or services by name, who it serves, where; never prices, fees, offers, hours, dates, policies, phone numbers or
addresses; nothing the documents do not say; disagreeing facts left out), the owner reads and edits it in a review
window and saves it (`PUT /api/agent-config { profileSummary, profileSummarySourceIds }`). It then sits in ABOUT THIS
BUSINESS ("Summary of the business, from its own documents, approved by the owner: …") on every turn, under the same
narrow grounding exception as the purpose: "who are you / what do you do" are answered at once, while a price or a
detail is still searched for. Rules that must not drift:
- **No price in a summary, ever** — prices change, and a summary in every prompt would quote a stale one with
  confidence. Twice: sentences with a price (a currency next to digits, "/month", "% off") are removed from the AI's
  draft and SHOWN to the owner; a summary with a price is REFUSED on save (`validation:summary.hasPrice`), whoever
  wrote it. Written-out prices ("fifteen hundred rupees") are not caught — the instruction is the first line.
- **Only documents the AGENT may use** (§6.28): the others come back as skipped ("limited to other agents") and never
  reach the model. A new agent copies the summary only when every document it came from is shared.
- **The server records the sources** (`resolveSummarySources`: id, title, a hash of the text NOW); a client never says
  what a document contained. A document whose TEXT changed since (a rename is not a change) or that was deleted makes
  `GET /api/agent-config` report `summaryStatus.stale`, and the Agent tab says which one — the owner summarises again.
  Nothing is regenerated without the owner.
- Saving from the review window writes only the summary; unsaved edits in the Agent tab are left alone. The Agent tab
  shows, edits and removes it (Save button), live-flagging a price with the same rule.
**Verified:** tests/summary-rules (8), `test:agents` (scoping, stripping, the prompt per agent, staleness, copying),
the review window driven in a browser (with the model's answer mocked: no model key in the build sandbox) and the
error shown readably when the model is unavailable. **Not verified:** a real model's draft quality, in either language.

**Built, NOT adopted — document title in the embedding.** `chunkDocument(text,
{title})` can prefix every chunk's `embedText` with the humanised document
title ("12-storepulse-plans.csv" → "storepulse plans"), which also gives a
heading-less file like a CSV a breadcrumb; `content` and `heading` are never
touched. It is wired through `ingest.js` behind `EMBED_DOCUMENT_TITLE = false`
in `embed-scheme.js` because it changes every vector it touches: it needs a
re-embed of existing rows and a re-measured `MAX_DISTANCE`, and the evidence
that it helps is NOT in yet. Honest expectation: it can help a file called
`company-overview.md`, not one called `scan0042.pdf`, and given the About
chunk is 0.05–0.09 over the gate it may not be enough alone. Do not flip it
without the before/after `eval:real` run.

**BUILT — generic openers are recognised and searched with the business name (`lib/phrases`).**
The words are DATA, one file per way of writing, so a speaker of the language can extend them
without touching code: `src/lib/phrases/en.js`, `ur.js` (Urdu script), `roman-ur.js` (Urdu in
English letters, with a `SPELLINGS` table — "ap/aap", "kia/kya", "batao/bataen" — because nobody
spells Roman Urdu the same way twice). Five groups: `identity` ("who are you", "آپ کون ہیں",
"ap kon ho"), `about` ("tell me about your company", "اپنی کمپنی کے بارے میں بتائیں"),
`offerings` ("what do you do / sell / what services", "aap kya karte hain"), `help` ("how can you
help me"), `aiCheck` ("are you a robot?", "kya aap insaan hain"). Plus each language's FILLER
(please, ji, zara…) and the greeting's notice words (§6.24). `index.js` is the matcher: a phrase
must match AND every other word must be filler or the business's own name (or its start —
"Nyron" for "Nyron Software Solutions"); `about`/`offerings` allow one extra word. Pure, no model
call — the first thing said on most calls must cost nothing.
- **What a match does** (`query.js retrieveForTurn`, before the follow-up logic): an overview group
  is searched as `"<businessName>: <message>"` (trigger `overview`, no rewrite spent); `aiCheck` is
  not searched at all (trigger `ai_check`). The gate is untouched — only the search key changes —
  and a false positive costs a search for the company's own overview. No name (placeholder) → the
  message as typed. The prompt gets a per-message line (`THIS MESSAGE is a general question about
  the business…` / `…asks whether you are a person or a machine…`), placed before the conflict rule,
  which stays last; and EVERY prompt now says "if asked whether you are a person, a robot or an AI,
  say honestly you are the business's AI assistant; never claim to be a human". A voice turn
  answered this way with no document is logged outcome `profile` ("answered from your business
  profile"), not `no_knowledge`; and `handoff/phrases.js isProfileQuestion` counts every opener, so
  an opener never counts as "the agent did not understand" (§6.26).
- **Measured, rules only (`tests/phrases.test.mjs`, no quota):** all 15 generic openers in
  `eval-questions.mjs` (`generic_overview` 8, `report_phrasings` 7) are recognised and none of the
  other 79 questions is. Tuned with that set in view — read it as "fits the set", not a live rate.
- **NOT measured — the retrieval gain.** Whether `"<name>: <question>"` now clears the gate for the
  About chunk needs embeddings (quota, §8 limitation 3). Expected from the probe above (queries
  naming the brand land at ~0.30) but unproven; the `eval:real` run of §9.1 item 1 decides it
  (`generic_overview`, `report_phrasings` and `off_topic` — no new leak). The profile answers the
  openers either way.

**Embedding quota is counted per TEXT, not per request** (probed directly with
the quota at ~13 left: batches of 2, 3 and 5 succeeded; a batch of 10 got a
429; three single-text calls then succeeded before the next 429 — a
per-request quota would have let the batch of 10 through). So batching embed
calls saves latency, not quota — `embedTexts` and the batched ingest (16 per
request) exist for that, and say so. Budget ~1000 TEXTS/day: a full 58-chunk
corpus ingest is 58 of them and an `eval:real` run is ~90. A batch also fails
whole, so near the cap a batch of 16 can 429 while single calls would still
have succeeded. The window looks ROLLING rather than a single reset: a few texts
trickled back within hours of exhaustion.

**Also pending for that same pass — `CHUNK_LOSSLESS` (`embed-scheme.js`, built, OFF).**
Found by tests/chunk.test.mjs, not by any eval: chunk.js silently DROPS text. (1) A
section over 1,400 chars was split into "sentences" by a regex that only matched text
ending in . ! ? or at the very end, so any fragment ending at a newline vanished —
a hard-wrapped PDF section (exactly what `extractPdf` emits) kept 1 of 39 lines, a
150-row CSV kept 1 row. (2) The LAST line of a document counted as "followed by a
blank line", so a short title-cased final line was taken for a heading and dropped.
Both are fixed in `chunkDocument(text, { lossless })`, default `CHUNK_LOSSLESS =
false` because they change every vector they touch (§6.2) — existing rows were built
from the lossy text. To adopt: set true, bump `EMBEDDING_SCHEME_VERSION`, then the
sequence below; expect more/different chunks, so re-measure `MAX_DISTANCE` and
re-run `eval:real`. **Until then, any PDF section over ~1.4k chars or CSV over that
size already in a knowledge base is missing most of its text** — `reembed` re-chunks
from stored `content`, which is complete, so the bundled re-embed repairs them.
Both modes are pinned by tests (legacy mode included, so flipping the flag is a
deliberate act). Still unfixed and by design: a title-cased line before a blank line
anywhere is read as a heading and its text lives only in the breadcrumb.

**The planned, once-only embedding pass** (whenever the quota allows ~800 texts):
`npm run eval:embedding-variants -- --dry-run` says what it still needs (281 texts
cached-aware for V0–V3); run it (resumable, cached in `node_modules/.cache`), adopt
the winner in `embed-scheme.js` and bump the version, `npm run reembed:dry` (52
documents, 227 chunks across the test tenants today — 23% of a day), `npm run
reembed`, then the §6.3 re-measurement.

### 6.21 A replace re-embeds only what changed

`ingestDocument` — which every replace, edit and retry goes through — used to embed
every chunk of a document even when one price changed. It now hashes each new
chunk's `embedText` (SHA-256) and keeps the stored vector of any existing chunk
with the same hash. Edit one price in a 40-chunk document: **1 text embedded, down
from 40**. Unchanged re-upload or a retry of an already-embedded document: **0**.

- **The hash is STORED (`knowledge_chunks.embed_hash`), not recomputed from heading +
  content.** A rename rewrites `source_title` without re-embedding (§6.10); with the
  title-prefix scheme on, a recomputed hash would describe the new title while the
  vector describes the old one, and a vector would be reused for text it was never
  computed from. Nullable, no backfill: every row written before the column existed
  has NULL and is never reused, so the first ingest of each existing document is a
  full embed and later ones are incremental. `reembed` writes hashes too.
- **Never across scheme versions.** The lookup joins the source row and requires
  `embedding_scheme = EMBEDDING_SCHEME_VERSION` in the same statement as the vectors
  are read, so a re-embed finishing in between cannot leak an old vector in. A
  scheme-mismatch ingest is a full embed (tested). `reembedSource` never reuses at
  all: it only runs for documents behind the scheme, whose every vector is wrong.
- **Vectors are copied as pgvector text, never parsed into JS numbers** — a reused
  vector is byte-identical to the stored one. Distinct texts are embedded once even
  if a document repeats a paragraph under one heading.
- **Every §6.10/§6.14 guarantee is unchanged**: old chunks are only READ before the
  swap; embed → one transaction (delete + insert + scheme) → rollback of the row on
  failure; the cancel checkpoint is still BEFORE each batch (reused chunks cost no
  batch), and a document with nothing to embed still passes the closing checkpoint
  before it swaps. Loading vectors is best-effort: a read error means a full embed.
- **Where the saving stops (measured, tests/test-reembed.mjs).** Reuse is by exact
  text, so what matters is whether the edit moves chunk boundaries. A heading-per-
  section document: an edit touches its own chunk. A heading-less document is split
  greedily by size, so an edit that changes a paragraph's length across a boundary
  re-flows every chunk after it: inserting one 400-char paragraph near the top of an
  80-paragraph, 40-chunk document re-embedded 39 of 40. Same-size edits (a changed
  price) cost 1. Sub-chunks of one section carry a 150-char overlap, so editing the
  last 150 chars of a chunk also re-embeds the next.
- The result now also returns `reusedChunks` and `embeddedTexts`.
- `npm run db:check` asserts the column exists; `test:reembed` covers unchanged
  re-upload, one edit, retry, scheme mismatch, NULL hashes, mid-way failure and
  cancel, duplicate chunks, reordering, merge and split — and after each scenario
  checks that every stored vector equals the vector of its own text.

### 6.22 The OR keyword query — built, measured keyword-only, OFF

`plainto_tsquery` ANDs every word (§6.3), so a sentence-length question needs a chunk
holding ALL of them and the keyword half is silent. `src/lib/agent/keyword-query.js`
(`buildKeywordQuery`, pure, unit-tested) builds the alternative: the question's content
words — English + Italian stop words, question words and chat filler removed,
apostrophes split, de-duplicated, max 12 — joined with `|`, run with `to_tsquery` per
chunk config (the language-aware setup of §6.3 is unchanged) and `ts_rank_cd` with
normalisation 1. Every term is letters/digits only, so no tsquery operator can be
injected. A question that is ALL filler ("who are you") yields an empty query and falls
back to AND. Behind `USE_OR_KEYWORD_QUERY` in `retrieve.js`, **false**.

**Measured with `npm run eval:keyword`** — SQL over the 58 stored chunks of
`__eval_real__`, no vectors, no model, 94 questions; a document's score is its best
chunk, ties count AGAINST the expected document, documents with no signal are unranked.
hit@1 / hit@3 / any-signal:

| | AND (today) | OR | OR + norm 1 |
| --- | --- | --- | --- |
| factual (24) | 8 / 8 / 8 | 63 / 75 / 100 | **79 / 96 / 100** |
| phrased_loosely (11) | 0 / 0 / 0 | 36 / 64 / 100 | **55 / 91 / 100** |
| cross_language (10) | 0 / 0 / 0 | 50 / 60 / 90 | **60 / 70 / 90** |
| generic_overview (8) | 0 / 0 / 25 | 13 / 38 / 63 | **38 / 38 / 63** |
| report_phrasings (7) | 0 / 29 / 43 | 0 / 71 / 86 | **57 / 71 / 86** |
| **overall (60)** | **3 / 7 / 12** | 42 / 65 / 92 | **63 / 80 / 92** |

- **The problem is as bad as suspected:** today the keyword half has no signal at all
  for 88% of questions. `websearch_to_tsquery` is identical to AND on a plain sentence
  (it only ORs a literal "or"); it is not a candidate.
- Normalisation 2 (divide by length) and 8 (unique words) got 50–52 / 82 overall — a
  little better hit@3, clearly worse hit@1, because long chunks are over-penalised.
- Italian questions: AND matched an Italian-config chunk for 2 of 10, OR for 8 of 10, and
  the Italian document was the top keyword hit for 6 of 7 that had any signal. OR also
  gives English chunks a hit for 8 of 10 Italian questions — through the language-neutral
  terms (brands, plan names, numbers), exactly as §6.3 says.
- Misses left are mostly shared brand words ("ClinicHMS" is in six documents) and
  generic openers with no content word ("who are you": no signal) — vector search's job.
  The conflict questions (both sources in the keyword top 3) are 0% in every variant; the
  document round-robin (§6.3), not keyword score, is what surfaces both.
- Off-topic: 5 of 8 off-topic questions get SOME keyword score under OR (0 of 8 under
  AND). That cannot admit a chunk — membership is still `MAX_DISTANCE` alone and
  test:reembed asserts OR admits exactly the same chunks as AND — but it can reorder a
  leak that is already in the pool. Watch this one.

**What this does NOT show:** nothing here has vector search in it. Keyword score only
re-orders the vector-admitted pool, so whether OR helps or hurts the FUSED ranking is
only knowable from the integrated eval. **Do not turn the flag on without it.**

**Verified without quota** (`npm run test:reembed`, stubbed embedder, `maxDistance 2`):
with the mode off — and with `keywordQuery: "and"` — the SQL returns exactly what the
original query did (5 queries, same ids, same order); OR mode runs on questions,
filler-only, punctuation-only and tsquery-operator input.

**ADOPTION CHECKLIST (needs embedding + chat quota; ~94 embedding texts and ~23
rewrite calls with `--skip-ingest`, ~150 without):**
1. App running, provider healthy. Plain run FIRST, so the baseline gains the categories
   it has never seen (`report_phrasings`, the 3 extra `followup_offtopic`) in shipped
   mode: `npm run eval:real -- --skip-ingest` (a run with failed rewrites is INVALID and
   saves nothing — retry later).
2. Candidate run, read-only against that baseline:
   `npm run eval:real -- --skip-ingest --keyword=or`
   (`&keyword=or` / `keyword` in the POST body reach `retrieveRelevantChunks`; the
   baseline is never written by a candidate run; exit 1 on a regression > 3 points.)
3. Beyond the 3-point gate, read these by eye and do not adopt if any gets worse:
   - **cross_language** (baseline 100% / 100%, MRR 1.0): Italian↔English is where a noisy
     OR rank could do damage;
   - **off_topic** (baseline 88%, one leak "flight change fees"): no NEW leak — and that
     leak must not rank higher in the result list;
   - **report_phrasings**: the 7 openers of TEST-REPORT §4 (three pass today); none that
     passed may fail, and `generic_overview` must not drop from its 0%;
   - **conflict**: still 100% both-sources-present; **followup / followup_offtopic**:
     still 100% / 100% rejected.
4. If it holds: set `USE_OR_KEYWORD_QUERY = true` in `retrieve.js`, put the integrated
   numbers in its comment next to the keyword-only ones, run `npm run eval:real --
   --update-baseline`, and tell `CLAUDE.md` §6.3's "ANDs every term" paragraph it is
   history. No re-embed and no `EMBEDDING_SCHEME_VERSION` bump: this changes ranking,
   not stored vectors.

### 6.23 Tables keep their meaning — CSV and DOCX (built, OFF, part of the bundled re-embed)

**The audit** (`npm run audit:chunks`, read-only and offline: real `extractText` + real
chunking over every file in `test-docs/`; the scanned PDF's text comes from the stored OCR
copy). 114 chunks over 15 files; the problem files, worst first:

| File | What the pipeline did |
| --- | --- |
| `03-storepulse-pricing-plans.docx` | **Worst.** mammoth makes every table CELL a paragraph, and the chunker reads a short title-cased paragraph as a heading, so "Lite", "Pro" and "Unlimited" became headings and a heading with no body is dropped: "Email", "Email + Phone", "Enterprise", "Custom pricing" are **gone from the text**. The comparison table became 5 chunks of 14–44 chars, the header ("__Plan__ __Price__…") in one and each row's values scattered across the others. |
| `12-storepulse-plans.csv` | One heading-less 130-char chunk: header glued to rows, no column meaning. And only 2 of its 3 data rows — the last line was read as a heading and dropped (the end-of-document bug of `CHUNK_LOSSLESS`, §6.20). |
| `10-nyron-onboarding-scanned.pdf` | The only other heading-less chunk (536 chars): OCR returns text with no structure. Not a table problem; nothing built (title-in-embedding is the existing candidate). |
| `02-clinichms-pricing.pdf` | **Checked and left alone.** Its table survives as one chunk with the header line and one line per row; columns run together ("Up to 2 Email") but nothing is lost and the header travels with the rows. Doing better needs x-coordinates from pdfjs and a column detector — a heuristic, not a fix, so not done. |

Also visible: 34 of 114 chunks are under 180 chars (short sections, each under its own heading);
none over the limit. Reports are saved by `--out=`; `--structured` shows the converted corpus
(111 chunks, 1 heading-less, 29 under 180) and `--compare` prints before/after per file.

**What it does now, behind `STRUCTURED_TABLES` in `embed-scheme.js` (false)** —
`tables.js`, pure and unit-tested (tests/tables.test.mjs, 40 cases):
- Rows become **self-describing**: `Plan: Pro; Monthly Price EUR: 149; Stores: 5; SKUs: Unlimited;
  Support: Email + Phone`. Empty cells are omitted (an empty value would read as a fact); a
  cell beyond the header's width is "Column N"; header text is used verbatim — no units are
  invented ("Monthly Price EUR" already says EUR).
- Each group of rows starts with a `Columns: Plan, Monthly Price EUR, …` line, so **the header
  context is in every chunk**. Groups are ≤1,200 chars and each is its own same-level section,
  so chunks split exactly on row boundaries (no overlap tail cutting a row in half) and never
  reach the legacy sentence splitter.
- A CSV gets a **heading from the file name** ("12-storepulse-plans.csv" → "storepulse plans"),
  on every chunk. DOCX tables keep the heading already above them ("StorePulse Pricing Plans >
  Plan Comparison").
- Parsing: RFC-4180 quoting (commas, `""`, newlines inside quotes), CRLF/LF/CR, UTF-8 BOM,
  delimiter detected from ",", ";", tab, "|" by per-line consistency (a ";" file with decimal
  commas works), all-empty rows dropped, lenient on stray or unterminated quotes.
- **Missing header:** the first row is a header only if it is words (≥ half filled, no purely
  numeric cell, no repeats, nothing paragraph-sized). Otherwise columns are "Column 1…N" and
  the first row stays DATA. The opposite error exists and is accepted: an all-text table with
  no header looks like a header. No heuristic can tell the two files apart; a wrong "header"
  mislabels cells, a wrong "no header" is merely less descriptive.
- **Huge files:** a 20,000-row CSV converts in well under a second with no row dropped, and
  produces far more than `MAX_CHUNKS_PER_DOCUMENT` (400, now exported from `ingest.js`), so
  ingest refuses it with its existing "Document is too large: N sections" error. The converter
  never truncates silently; the cap is ingest's decision. Roughly 400 chunks ≈ 400×1,200 chars
  of rendered rows.

**Two seams, because the two formats store different things:**
- **CSV is converted at CHUNK time** (`prepare.js` → `chunksForDocument`, the one function
  ingest, retry, re-embed and the audit scripts all call), from the stored ORIGINAL text. So
  `npm run reembed` repairs CSV documents already in the knowledge base with no re-upload.
  (extractText was not the place: stored `content` would then be our rewrite, not their file,
  and re-embedding could not reach existing documents.)
- **DOCX is converted at EXTRACTION time** (`extractText`, via mammoth's HTML), because only
  the extracted text is stored and the table structure is already gone from every DOCX
  ingested so far. **Re-embedding cannot recover it: a DOCX containing a table must be
  RE-UPLOADED** after the flag is on. Find them:
  `SELECT tenant_id, title FROM ai_engine.knowledge_sources WHERE kind = 'file' AND file_name ILIKE '%.docx';`
  With the flag on, the whole DOCX goes through the HTML path (headings still "#", lists "•",
  bold markers gone) — a small text change for every DOCX, not only those with tables.
  Nested tables are left to the old behaviour.

**Before → after** (`npm run audit:chunks -- --compare`):
- `12-storepulse-plans.csv`: 1 chunk, no heading, 130 chars, 2 of 3 rows →
  1 chunk, heading "storepulse plans", 352 chars, all 3 rows, e.g.
  `Plan: Enterprise; Monthly Price EUR: Custom; Stores: Unlimited; SKUs: Unlimited; Support: 24/7 dedicated`.
- `03-storepulse-pricing-plans.docx`: 10 chunks with the table in shreds and 4 values lost →
  7 chunks; the table is one chunk under "StorePulse Pricing Plans > Plan Comparison" with all
  3 rows intact.

**BUNDLED RE-EMBED CHECKLIST — everything built, tested and OFF, to adopt in ONE pass** (the free
embedding quota is ~1000 texts a day, §6.20; `npm run reembed:dry` prints the cost and now
shows this flag):
1. `CHUNK_LOSSLESS` (§6.20 note) — chunker stops dropping text.
2. `STRUCTURED_TABLES` (this section) — self-describing CSV/DOCX tables.
3. Optionally `EMBED_DOCUMENT_TITLE` and `USE_EMBEDDING_TASK_TYPES` — only if `eval:embedding-variants` favours them.
4. Set the flags, bump `EMBEDDING_SCHEME_VERSION`, `npm run reembed:dry`, `npm run reembed`,
   `npm run db:check`, **re-upload DOCX files that contain tables**, `npm run eval:sweep` +
   `eval:real:sweep` → set `MAX_DISTANCE`, then `eval:real` against the baseline. A table
   chunk now embeds "Columns: … Plan: Pro; …" instead of "Pro,149,5": expect its distances to
   move — re-measure, do not assume.
5. Already independent of the above and ready: the incremental re-embed on replace (§6.21), so
   re-uploading a DOCX only pays for the chunks that changed.

### 6.24 Voice calls — a separate gateway, local speech, the same brain

**What exists:** the test console has a Call button. Press it, allow the microphone, and the
agent greets you and answers out loud from the tenant's knowledge. Each call is stored as a
`call_logs` row, a `call_turns` row per exchange (transcript, intent, outcome, sources, per-stage
timings) and a `call_events` timeline. A phone call is the same session over a second transport (§6.30); the design
kept it a transport swap (below).

```
browser mic ─ws─► VOICE GATEWAY (npm run voice, port 3001) ──────────────────────────────┐
  16 kHz PCM16     VAD (Silero) → STT (Parakeet) → respond(channel:"voice") → sentences →  │
◄─ PCM16 audio ─   TTS (Piper, per sentence) ─────────────────────────────────────────────┘
```

**Rules that must not drift:**

- **The gateway is a separate process, deliberately.** Next.js route handlers cannot hold a
  WebSocket open; the native speech runtime (~1 GB of loaded models) stays out of the web app;
  and it is the box that moves to its own CPU server later (§9.2). It imports the SAME `respond()`
  through the `@/` alias loader — it is an adapter over the one brain (§1), not a second brain.
  `session.js` builds no prompt, does no retrieval and calls no model. Every spoken word that is
  not generated ("one moment", the failure apology) lives in `prompt.js` (`voiceLine`); the
  greeting's wording lives in `lib/voice/greeting.js` (pure, because the console previews it as
  the owner types) and is reached through `prompt.js buildVoiceGreeting`.
- **The greeting is per AGENT and the owner's** (`agent_configs.greeting` `{en?, ur?}` +
  `record_calls`, migration `20261026100000_agent_greeting`, hand-written, HNSW line removed;
  console: Agent tab → `GreetingPanel`). Decided with the owner (Pakistan is the first market):
  - An empty box = the BUILT-IN greeting: "Hello, thanks for calling {name}. You're speaking with
    an AI assistant[, and this call is being recorded]. How can I help you today?" (Urdu the same,
    "اے آئی" in Urdu script, verb by voice gender). The recording clause is there ONLY while
    `recordCalls` is on — with recording off the built-in text never mentions recording.
  - The owner's own text (≤400 chars, `{business}` the only placeholder — anything else in braces
    is refused, it would be read out literally) is spoken EXACTLY as written. Nothing is added.
  - Instead the console WARNS (`greetingNotices`), with the reason: no AI notice ("the UK and
    Ireland (and the EU) require it… your choice"), recording on but not mentioned, recording
    mentioned while off. Warnings are never refusals.
  - A new agent copies both settings from the agent it starts from (§6.27).
  - `recordCalls` records nothing yet (no telephony, browser calls are never recorded); it drives
    the greeting today and is the switch the phone transport will obey. WHERE recordings are
    stored is the backend's decision (handoff doc).
- **`respond()` gained two OBSERVATION-only additions:** `onStage(stage, data)` ("retrieved",
  "first_token") and a returned `timings` object (+ `searchTrigger`). They change nothing about a
  turn, a throwing callback is swallowed, and the chat route ignores them.
- **Trust: a one-minute, single-use ticket** (`lib/voice/ticket.js`). The browser cannot hold
  `INTERNAL_API_KEY`, so `POST /api/voice/session` (internal-auth guarded, `requireServiceableTenant`,
  10/min per tenant) signs `{tenantId, agentId, expiry, nonce}` — plus the dialled number for a call "as if dialling"
  (§6.29) — with HMAC (`VOICE_SESSION_SECRET`, else
  `INTERNAL_API_KEY`, else a dev-only secret; NULL in production = every call refused). The
  gateway verifies it, refuses a replay, and re-checks `assertTenantServiceable` because it serves
  the tenant. Not the removed widget tokens (§2): those were long-lived public credentials.
- **Speech is behind seams.** `speech/stt.js` and `speech/tts.js` are the only entry points the
  session uses — the same pattern as `llm.js`. Models load ONCE at gateway start (`engine.js`:
  Parakeet, Silero, and the DEFAULT voices; other voices on first use, then kept);
  `decodeAsync` / `generateAsync` run on native threads, and each engine instance is used one
  call at a time (`serial.js`), so concurrent calls queue instead of oversubscribing the CPU.
- **Speech recognition does NOT depend on the reply language** (`VOICE_STT_PROVIDER=auto` by
  default). The reply language decides what the agent SAYS, never what it can HEAR: a business
  that chose English still has callers who speak Urdu or mix the two, and a recogniser picked from
  the reply language turned that Urdu into confident English nonsense (seen on a real call). So:
  **Groq Whisper large-v3** (hosted, free tier, `GROQ_API_KEY`) handles every call when a key is
  set — it understands Urdu, English and Urdu/English code-switching, which is how Pakistani
  callers actually speak; local **Parakeet** (fast, English, **no Urdu**) is the fallback and the
  keyless mode. There is NO local Urdu model good enough to ship (best open CPU models: 27–34%
  word error on Urdu). Whisper is not given a language hint (a fixed hint forces the other
  language into the wrong one); it gets a short primer in Urdu script plus English, and if it
  still answers in Devanagari the same audio is asked once more with `language=ur`. A Groq failure
  or 6 s timeout falls back to Parakeet for that utterance and is logged
  (`stt.completed.fallback`). Without a key an Urdu-speaking caller is NOT understood: the call
  logs `stt.urdu_unavailable` and the console's voice picker says so.
- **Voices — a catalog of only real voices** (`speech/voices.js`, pure, imported by the gateway,
  `PUT /api/agent-config` and the console). Two engines:
  - **Natural — Kokoro-82M v1.0, fp32** (Apache-2.0): US/UK English and Urdu, male and
    female. **fp32, not int8**: measured, int8 ran at 1.3–1.6× real time on this CPU (slower than
    speech — unusable live), fp32 at ~0.57×. One engine instance per language (the phonemizer
    language is per instance).
  - **Fast — Piper** (US English Lessac/Ryan): ~0.13× real time, more
    synthetic.
  - **Urdu = Kokoro's Hindi speakers + espeak-ng's Urdu phonemizer** (engine language `ur`) —
    spoken Urdu and Hindi are one language at the sound level and the phonemizer reads Urdu script.
    Checked by transcribing the output with an independent model: word-for-word correct, rated
    5/5, identified as Pakistani Urdu. Meta's MMS Urdu voice is **CC-BY-NC (non-commercial) — never
    use it**.
  - `agent_configs.voices` = `{ [language]: voiceId }` (migration `20261010180000_agent_voices`,
    hand-written, HNSW line removed). `voiceFor()` never returns a voice of the wrong language — a
    bad id degrades to that language's default. Defaults: `kokoro:af_heart` (English), `kokoro:hf_alpha` (Urdu).
  - The gateway serves `GET /voices/preview?voice=` (a fixed sample line per language, synthesised
    once per voice, 30/min per client) for the console's ▶ Listen; `/health` lists installed voices.
- **The recogniser is taught the business's name** (`lib/voice/vocabulary.js`, applied inside
  `stt.forCall({replyLanguage, vocabulary})` so every engine gets it). Neither engine has heard
  of the business: Parakeet writes "Nyron" as "NIRON"/"NIRN" even for clean synthetic speech, and
  one real call produced "Nairan", "Niron", "Nairawan" — 4 of 5 turns then answered "I don't have
  that information" (the search embedded the wrong word and found nothing; the empty result cost a
  rewrite and a second search; gpt-oss, handed "Niron", declined even with the overview
  retrieved). A capitalised word with the name's first letter and consonant skeleton (y/w/h count
  as vowels) is replaced; at a sentence start it must also be within one letter, so "Small" never
  becomes "Smile". Whisper also gets the vocabulary as its `prompt`. Corrections are logged on
  `stt.completed` (`corrected`). Backstop in the prompt: `voiceHearingInstruction` tells the model
  the customer's words are a transcript and sound-alike names mean that name. Product names are not
  in the vocabulary yet — same matcher, a new source.
- **The agent's gender is the voice's gender.** On the voice channel the prompt states it
  (`voiceGenderInstruction`), so Urdu self-references agree with what the caller hears
  ("میں کر سکتی ہوں" for a female voice); the Urdu greeting picks سکتی / سکتا the same way.
- **Turn flow:** VAD finds the utterance (after `VAD.minSilenceSeconds` = 0.5 s of silence — the
  biggest fixed latency, paid on every turn) → STT → `respond()` streams → `SentenceChunker` →
  each chunk is synthesised and sent while the next one is still being generated. Turns are
  strictly serial per call. An STT result with no letters is noise: no turn, no brain call.
- **Progressive chunking** (`sentences.js`) — the fix for silence in the middle of a reply.
  Kokoro synthesises at r ≈ 0.57×, so chunk k is ready in time only if
  `Lk ≤ L1 + ((1−r)/r)·(L1+…+Lk−1)`; with r = 0.67 for headroom that is **L1 + 0.5 × everything
  already sent**. First chunk ≤ 48 chars (may run to a comma within 25% more), later chunks
  40–240 and the cap is STRICT. Breaks: comma → strong joiner ("which", "because", "according
  to", "کیونکہ"…) → weak joiner ("and", "اور") → space; never mid-word. A tiny first sentence
  ("Sure!") waits and goes out with the next when the pair fits; when it does not, "Sure!" goes
  out alone ON PURPOSE. Taking the start of the next sentence with it was tried: no gap after it,
  but the first word came 2.1 s after the reply started instead of 0.54 s (a real call session,
  real Kokoro); alone, the wait it costs is ~365 ms more pause BETWEEN two sentences, where a
  listener expects one. Speed wins. Measured: a 230-char second sentence left ~6 s of
  silence; a fixed per-index schedule still left 810 ms (comma slack on chunk 2); the derived rule
  measured **0 gaps on four real calls** (`voice:smoke -- --call` reports gaps).
- **No long silences INSIDE a sentence** — the "tell me about …… your name" complaint. Measured on
  the real voices first: every engine starts and ends a piece with its own quiet (Kokoro 50–100 ms
  before, 70–90 ms after; Piper up to 190 ms after), and 160 ms was added after EVERY piece — so a
  sentence cut in two had ~300 ms of dead air at the join before any synthesis delay. Now:
  `audio.js trimSilence` cuts the engine's quiet (20 ms / 40 ms kept so soft sounds survive);
  `tts.synthesize({pauseMs})` adds the pause the JOIN needs, from `sentences.js chunkEnding`: none
  between two pieces of one sentence (`TTS.joinPauseMs` 0), 120 ms at a comma, 240 ms after a
  sentence (≈ the old ~300 ms rhythm once trimmed); and a cut never lands right after a word that
  leads on ("about | your", "the | price", a number: "two | visits") or right before an Urdu
  postposition ("آپ | کا"). Through a REAL call session (real Kokoro, a fake brain streaming three
  replies like a fast LLM, this sandbox CPU): **0 gaps inside any sentence**; the only gap was 365 ms
  after a lone "Sure!". **`npm run voice:gaps`** (real voices, this sandbox CPU, replies streamed
  at 400 chars/s): silence inside a sentence **Kokoro English 313 → 135 ms average (max 180),
  Kokoro Urdu 359 → 100 ms, Piper 317 → 132 ms**; between sentences unchanged (~300 ms). Speech is
  still understood: `voice:smoke` 0% word error on every voice at 16 kHz and simulated phone audio
  after trimming. **A machine that makes speech slower than it plays still has gaps** (synthesis
  ×2: 0.5 s average, 1.2 s max inside a sentence) — no chunking can avoid that. Speaking whole
  sentences on a slow machine was measured and **rejected**: it moves the waits between sentences
  and makes them 2.5 s on average, up to 3.2 s (4.2 s even at normal speed) — which also sounds
  like the agent has finished. The call instead logs `tts.slow` once (`TTS.slowRatio` 0.9) and every
  gap the caller heard (`tts.gap`, with `inSentence`; the turn's timings carry `gapCount` and
  `maxGapMs`). The fixes for a slow machine are the fast voice or the speech server (§9.2).
- **Fixed lines are synthesised once** (`tts.js` cache, `cache: true`): greeting, fillers and the
  apology are the same words call after call, and Kokoro needs ~2.5 s for a greeting. The fillers
  are pre-warmed after the greeting. A reply is never cached. The greeting is spoken sentence by
  sentence, like a reply: a voice's FIRST greeting (nothing cached) was 5.5 s of silence after
  pick-up when spoken whole.
- **Query embeddings are cached** (`retrieve.js embedQuery`, exact text + scheme version): a
  repeated question skips the ~1 s embedding round trip — measured 1020 ms → 50 ms — and spends
  no quota.
- **Spoken style** (`CHANNEL_STYLE.voice`): times and prices as people say them ("nine in the
  morning", never "09:00" or "zero nine hundred"), no document names or dates unless documents
  disagree, Urdu in Urdu script (never Roman Urdu — the voice could not read it). Gemini Flash-Lite
  does not always obey the document-name rule.
- **Barge-in:** caller speech while the agent is thinking or audible, sustained for
  `BARGE_IN.minSpeechMs` (350 ms, so "mm-hm" does not cut the agent off) → `audio_clear` to the
  client, the rest of the reply is never synthesised, the turn is logged `interrupted` with
  `spokenText` = what was actually heard. "Audible" is the client's playback report OR the
  gateway's own estimate from the audio it sent — the second does not depend on the transport, so
  Twilio inherits it. The stored reply is then cut to what was heard (turn-quality item 5 below).
- **Filler:** no reply audio `FILLER.afterMs` (2.5 s) after the caller stopped AND the model has
  produced nothing yet → a short holding line, rotated ("Let me check that for you.", "Sure, just
  a moment."…). It used to fire on every turn — even "what are your hours?" — 0.9 s before the
  answer started; callers heard the agent stalling on simple questions. It is a symptom
  detector for a stuck LLM, not a feature.
- **A failed turn does not end the call:** the caller hears `voiceLine("fallback")`, the turn is
  logged `outcome: failed` with the error, and the call keeps listening.
- **Intent is rule-based, never a model call** (`intent.js`): question | followup (the rewrite
  actually changed the search) | greeting | acknowledgement | goodbye | human_request | hold ("hold
  on") | presence ("yes, I'm here"); outcome answered (has sources) | profile (a generic opener
  answered from the business profile, §6.20) | no_knowledge | conversational | handoff_requested | failed. A model
  classifier would spend the scarce chat quota (§8 limitation 3) on every turn for something no
  caller hears; a semantic taxonomy belongs in an offline job over `call_turns`.
- **Logging never slows a turn:** `recorder.js` tracks every write and `close()` awaits them, but
  no turn awaits one; timeline events are batched (one INSERT per 400 ms). A failed log write is
  logged and dropped. `call_events.seq` carries the order explicitly.
- **Which language a sentence is spoken in:** the business's `replyLanguage` decides, with one
  exception that matters in Pakistan — an Urdu-call sentence made only of Latin letters (a brand,
  a code, an English phrase) is spoken with the English voice, because the Urdu voice would spell
  it out as gibberish (`spoken-language.js`). A sentence with no letters keeps the previous one's
  language. The greeting is in the reply language — the UI language is never consulted (§7).
- **Turn quality — five fixes found on real calls** (tests: voice-session, voice-continuation, collect-engine):
  1. **No document search for a checklist answer.** While a request is open, a message the RULES read as
     the answer to the question just asked ("0300 1234567", a name, "root canal", "tomorrow at five", "yes",
     "thanks") skips retrieval (`collect/engine.js readsAsAnswer` → respond.js, `searchTrigger: "skipped"`).
     Conservative on purpose: a question, a message over 10 words (16 for a phone number said digit by digit)
     or anything the rules cannot place is still searched. Saves ~1–2 s and an embedding per such turn, and the
     turn is logged `conversational`, not "unanswered" (`classifyTurn requestState`).
  2. **A sentence cut by a pause is one message** (`voice/transcript-clean.js looksUnfinished`, `CONTINUATION`
     in `config.js`). A transcript ending on a joining word or comma ("…with", "…اور", ",") is held 1.2 s
     (after the 0.5 s of VAD silence); if the caller carries on, the halves are joined (`utterance.merged`),
     else the held half is answered as it is. A finished sentence never waits.
     **And the LATE merge**, for a first half that sounded finished ("I want to book an appointment." …
     "for tomorrow at five"): if the caller starts speaking again within `CONTINUATION.lateMergeWithinMs`
     (3 s) of the end of the previous utterance AND has not heard a word of the answer yet, the turn in
     flight is WITHDRAWN and both halves are answered as one message, shown under the same turn number
     (`turn.withdrawn`, `utterance.merged` with `late`). `respond({ signal })`: a withdrawn turn puts back
     everything it wrote — the caller's message, the request draft, the handoff state, the same rollback a
     failed reply already had — and throws `TurnSupersededError`; honoured until the reply is stored (after
     that it is an ordinary interruption, item 5). Costs a finished sentence nothing: no turn waits for it.
     If the rest was noise, the first half is answered alone. Past 3 s, or once the agent has spoken, the
     new speech is its own turn. (Tests: voice-session for the call flow; `test:collect` withdraws turns
     against the real database — before and mid-stream — and checks the message and the draft are put back.)
  3. **Doubled transcripts are collapsed** (`collapseRepeats`): a phrase of 3+ words written twice by the
     recogniser reaches the brain once (`stt.deduped`). "No, no, no" and "very very good" are left alone.
  4. **No "one moment" filler while collecting details** (`turn.collecting`, set from the `retrieved` stage's
     `collectionState`): "Let me check that for you" before "Thanks, I've noted your number" sounded wrong.
  5. **An interrupted reply is stored as what was heard** (`respond.js trimLastReply`, called by the session
     after a barge-in): the brain persists the whole generated reply; the spoken part replaces it (or it is
     dropped if nothing was spoken), so the next turn never builds on words the caller did not hear.
  6. **The conversation is not interrupted by a pause** (`session.js onPause`, `lib/phrases` PAUSES —
     English, Urdu script, Roman Urdu). "Hold on, let me find my card" / "ek minute" / "ذرا رکیں" →
     a fixed "take your time" (`voiceLine("take_your_time")`) and the silence check-in waits 60 s instead
     of 15 (`SILENCE.hold`, back to normal at the next real message). "Yes, I'm here" right after "are you
     still there?" → a fixed "go ahead" (`voiceLine("listening")`); anywhere else "yes" is an answer and
     goes to the brain. A question is never a hold ("wait, how much is it?"). Neither the pause line nor
     the check-in is sent to the brain or stored as a message, so the next real question follows straight
     on from the exchange before the pause — the model's memory of it is not broken by "are you still
     there? / yes". Logged as turns with intent `hold` / `presence`.
  **Not done:** echo of the agent's own voice through speakers (4–13 "interruptions" per call without
  headphones) needs an echo guard tested on real audio.
- **Limits** (`config.js`): 15 min per call, 3 concurrent calls per
  tenant, 6 per gateway (a CPU budget for this machine, not a business rule), 20 s max utterance.
- **Wire protocol** (`protocol.js`, imported by both sides): binary frames are PCM16 audio, text
  frames are `{type, …}` JSON. **A payload must never carry its own `type`** — a timeline event is
  sent NESTED as `{type:"event", event}`. Found live: spread, the event's `type` overwrote the
  message type and the console never showed the timeline; the transport now throws on it and a
  test pins it.
- **Migrations** `20261010120000_voice_calls` and `20261010180000_agent_voices` are hand-written;
  each generated diff's first line was the HNSW `DROP INDEX` (§6.1) and was removed.

**THE LLM IS THE LATENCY PROBLEM — measured, not assumed.** The real voice prompt (708 input
tokens) sent to Gemini's free tier: **thinking tokens 0, and the whole reply arrives ~240 ms after
the first token — but the first token takes 3.5–10 s, on every model tried**
(`gemini-3.5-flash-lite` 6.5 s, `gemini-3.1-flash-lite` 10.3 / 4.8 / 3.5 s on consecutive calls,
`gemini-flash-latest` 6.5 s; two older models 404, one 503). That is free-tier queueing; no request
setting changes it (`thinkingBudget: 0` is even rejected). Occasionally it answers in ~0.6 s. Hence
`groq.js` (`LLM_PROVIDER=groq`, Gemini as fallback): Groq's free tier publishes ~0.7–1 s to first
token. **Measured since (one real call, 5 turns, laptop on battery): Groq first token 0.43–1.12 s**
— the LLM is no longer the bottleneck. That call still took 6–7 s to first word, and where the
time went: STT 1.0–1.7 s (4.0 s for a 10.7 s utterance — Parakeet's cost grows faster than the
audio: 3.7 s → 0.5 s, 8.75 s → 2.7 s; 2 vs 4 threads made no difference), search 1.2–2 s
(Gemini query embedding, plus a rewrite and second search whenever the misheard name made the
first search empty — fixed above), first chunk of Kokoro 2.9–3.1 s (1.8 s for the same sentence
with the machine otherwise idle: on battery, with Chrome and the dev server busy, Kokoro ran at
~1.2× real time, not 0.57×). The rewrite on gpt-oss-120b: median 0.59 s, p90 0.98 s over the 23
conversation items of the eval set, outputs correct; gpt-oss-20b was only ~0.15 s faster and
translated three English follow-ups into another language, so it is NOT a rewrite model. Benchmark the
speech stages on mains power; the dedicated speech server (§9.2) is the real fix for CPU contention.

**Measured on this repo's dev machine (i7-1185G7, 4 cores / 8 threads, CPU only)** —
`npm run voice:smoke`, zero quota, synthetic speech (cleaner than a human — real accuracy will be
lower):

| | Kokoro (natural) | Piper (fast) |
| --- | --- | --- |
| TTS per sentence | 1.3–2.1 s (0.57× real time, 4 threads); first chunk 0.86 s at 8 threads | 0.26–0.56 s (0.13×) |
| Word error after STT round trip, 16 kHz / simulated 8 kHz phone | 0% / 0% (en and it — measured before Italian was removed) | 0% / 0% |
| Urdu | 3.1–3.2 s per 5.5 s sentence (0.56×) | — |

STT (Parakeet) 0.2–0.5 s per utterance. Model load ~10 s at gateway start (three Kokoro languages).
Real calls with the natural voice on the free Gemini tier: STT 0.2–0.4 s, retrieval 0.9–1.1 s
(0.05 s when cached), LLM first token 0.6–1.5 s on lucky calls, first chunk 1.2–1.6 s →
**~3.1–3.8 s end-of-speech → first word**, no mid-reply gaps. Remaining levers, in order: a fast
LLM (Groq), Kokoro at 8 threads (now the default), the fast voice tier for latency-critical lines,
the 0.5 s VAD window.

**Not built:** call recording itself (`recording_url` stays null; the per-agent `recordCalls` switch and the greeting's
notice exist); Twilio `mark` events for exact playback (§6.30); a local Urdu recogniser. (The Twilio transport and webhook
are built — §6.30.)

### 6.25 Taking a request — appointments, call-backs and orders (the collect domain)

**What exists:** the owner ticks, in the console's "What your agent collects" tab, which details
the agent must ask for (name, phone, service, date and time, party size, reason…), per kind of
request (appointment, call-back); the agent then takes those details in conversation — chat or
voice — validates them, **saves the request the moment every required detail is in**, then reads it back
and updates the saved row if the customer corrects something. A "Collected" tab lists what was
taken. Backend responsibilities that are stood in for are in
[`docs/handoff-to-backend.md`](docs/handoff-to-backend.md).

**Rules that must not drift:**

- **Configuration over code.** `lib/collect/catalog.js` is DATA: FIELDS (how a detail is asked and
  checked), RECORD_TYPES (which fields make one kind of request), INDUSTRIES (a starting
  selection). A new kind of business is a new preset, never a new code path. Stored per AGENT (§6.27) as
  one JSON document, `agent_configs.collect`, versioned (`collect_version`), replaced whole by
  `PUT /api/collect`. Reading a stored document never throws (bad values degrade to the nearest
  valid one — a conversation is waiting); a save returns translated, specific refusals, including
  "this request type has no way to reach the customer".
- **A state machine owns the collection, not the model** (`collect/engine.js advanceCollection`).
  §6.11 says the model never mutates tenant data; this is how that stays true while it still
  sounds natural. Each turn the engine decides the PLAN (which field to ask next, or read back, or
  finish); the model only WORDS that plan (`prompt.js buildCollectionInstruction`); every value is
  judged by code (`validate.js`), never by the model. A model that invents a phone number gets as
  far as the format check.
- **Understanding is two layers, cheapest first** (`extract.js`): rules for the field just asked
  about (free, works with the provider down), then ONE small extraction call that reads the whole
  message against the fields still missing ("I'm Ahmed, root canal tomorrow after five" fills
  three). Extraction runs in PARALLEL with retrieval, has its own circuit breaker
  (`llm.js generateExtraction`) and fails soft to the rules — a turn is never lost to it.
- **Starting:** rule-based detection of "I want an appointment / call me back" in English, Urdu
  script and Roman Urdu (`phrases.js`; the thing asked for FIRST wins; "reschedule/cancel my
  appointment" starts nothing — the agent has no bookings to look up). A model fallback:
  `[[START appointment]]` at the start of a reply (`marker.js`) — stripped from the stream, the
  transcript and the voice before anyone sees or hears it.
- **Saved FIRST, read back AFTER — there is no "say yes to save" step.** It used to wait for a
  spoken yes, and a caller who said "thanks" and hung up (or a model that wandered off the plan)
  left nothing behind. Now `advanceCollection` calls `deps.submit` as soon as every REQUIRED field
  has a value — before the optional questions, which then follow and each answer UPDATES the saved
  row (`deps.update`). Stages: `collecting` → (`recordId` set on save) → `saved` once nothing is
  left to ask. In `saved` the customer is told the number and the details are read back; a
  correction ("no, the phone is …") rewrites the SAME row, never a second one; "thanks"/"that's all"
  (`phrases.js isClosing`) or a yes closes it and clears the draft; "no" asks which detail is wrong;
  a different request ("call me back too") starts a fresh draft. After MAX_MISSES unanswered tries the
  engine gives up politely (only possible before the save — afterwards every required field is in).
- **Taking back is narrow.** "Cancel it"/"forget it" (the STRONG cancel phrases only — a weak
  "maybe later" must never undo a request) calls `deps.withdraw`, which cancels the row ONLY while it
  is still `requested`. A person's confirm locks the row: `updateRecordDetails` and `withdrawRecord`
  are conditional on `status = requested`, so the agent cannot quietly rewrite what the team already
  acted on — the customer is told a team member will adjust it (`update_failed`).
- **The result is a `requested` record, never a booking.** `standins/records.js createRecord`
  is idempotent on `submissionKey` (a retried turn is the same row and reference; a failed save is
  retried on the customer's next message under the same key); the customer is told the team will
  confirm; only a person moves it on (`PATCH /api/records/:id`, console only).
- **Draft:** the in-progress details live in `conversations.collect_draft`, expire after 30
  minutes (`DRAFT_TTL_MS`), and are rolled back if the reply fails (so a failed turn is repeated,
  not half-applied — a repeated save finds the same row by its submission key). Dates are checked in the business's time zone against its opening hours; a
  time is a wall-clock string (`scheduledLocal`), not an instant.
- **Urdu specifics:** digits in Urdu/Arabic-Indic form and spoken digits are normalised; yes/no
  is token-based ("جی نہیں" is NO — "ji" is a filler); regexes use Unicode word edges, never `\b`.
- **Stand-ins, not a second backend.** `lib/standins/*` (customers, records, events) sit behind
  fixed interfaces; nothing else touches those tables. The AI never reads them back (§6.11).
- **Orders (restaurants) — the third request type, `order`** (reference `OR-…`). Fields: name, phone, `order_items`,
  `order_type` (pickup | delivery), `address` (asked ONLY for delivery), `notes` ("when you'd like it, the spice level,
  or an allergy" — one open question; `order_time` exists for an owner who wants the time on its own). On in the
  restaurant preset, off elsewhere (switchable in every business). Rules that must not drift:
  - **Only dishes on the business's MENU** (`collect.menu`, the owner's own list like services, ≤150). `order_items`
    (field type `items`, `collect/order.js`, pure) is read by the RULES — the menu's own dish names in the message
    (English, Urdu script, Roman Urdu; "two", "do", "دو", "2 plates of", "x 3"; a plural or a one-letter slip in a
    long word) — and, when the rules leave words over ("…and a PIZZA"), by the extractor too, which writes
    "2 x Chicken Biryani; 1 x Pizza". The two are COMBINED: the rules' dishes plus what only the model heard. A dish
    not on the menu is never written into the order; the caller is told (`not_on_menu`), and the rest of the order
    is KEPT (`partial` — the caller does not repeat the other dishes). A word that fits several dishes ("biryani" with
    chicken and beef biryani) is asked about (`ambiguous_item`), never guessed. A generic word ("chicken") alone is
    never a dish. Stored as `[{id, name, qty}]` — `name` keeps an old order readable after the menu changes.
  - **An order already taken changes only when the caller SAYS so** (`mentionsOrderChange`: add / also / another /
    remove / make it / no X / "hata dein" / "aur bhi" / "ہٹا دیں"): "make it three biryanis" sets the number,
    "another coke" adds one, "no raita" removes it — and "House 5, Biryani Street" never adds a biryani. After the
    save a change updates the SAME request, like any correction.
  - **Pickup or delivery** is a fixed `choice` with the ways callers say it (`options[].also`: "takeaway", "khud le
    jayenge", "ghar pe bhej dein", "ڈیلیوری"). It may be noticed unasked ("Ahmed, it's for delivery"), never from a
    question, and an answer already given changes only on "instead / actually / ki jagah".
  - **Conditional fields — `when: {field, equals}`** on a record type's field (catalog data, kept by the console):
    asked only when an earlier answer is that value. A field that does not apply is not asked, not required, not in
    the read-back and not sent to the team (switching to pickup drops the address from the saved request). A broken
    condition is refused on save (`conditionInvalid`) and DROPPED on read (asked always: one extra question beats a
    required detail never asked); removing the source question in the console clears conditions on it.
  - **No menu, no orders** (`needsList: "menu"`): the type stays switched on and the settings save, but
    `enabledRecordTypes` leaves it out — the agent never offers orders — and the console warns
    (`missingLists`, "your menu is empty").
  - **Never "your order is placed", never a price it was not given:** an order plan tells the model the order is
    noted and the team confirms it and the total; prices and totals only from the reference material.

**Verified:** `npm test` (539 unit tests, incl. the whole engine with faked extractor),
`npm run test:collect` (the full flow against the real database with a faked model: configure →
converse → save at the last required detail → correction updates the same row → optional answers update it → close → idempotent retry → status workflow and the lock on worked-on rows), screenshots of both tabs in
English and Urdu/RTL. **Not verified:** the real model's wording of a plan turn in Urdu on
every provider; real Pakistani callers through the voice path; the extraction call's latency
against a real provider (it runs in parallel with retrieval, but nobody has timed it).

**Orders verified:** tests/collect-order (26: the reader in three languages, menu checks, merging, pickup/delivery,
conditions, the full conversation for pickup and delivery, a dish not on the menu, an ambiguous dish, a change after
the save, the prompt), `test:collect` (an order through `respond()` on the real database: no menu → no order; with a
menu → OR- reference, dishes stored, address for delivery, "add a coke" updates the same row). **Not verified:** the
real extractor's "2 x dish" output on a real provider, and real callers ordering in Urdu.

**Not built:** WhatsApp/SMS confirmation to the customer's phone; slot availability (opening
hours only); modifying or cancelling an existing booking or order; prices, totals and stock (the team confirms them); tool execution of any other kind
(`TOOL_EXECUTION_AVAILABLE` stays false — collecting is not executing).

### 6.26 Passing a caller to a person, ending calls well, and the marker that leaked

**Scenario one — "forward the call to a representative / senior / lead".** The owner switches
*Call forwarding* on (Agent tab → `HandoffPanel`), lists people in the order they should be tried
(role, name, phone) and sets how patient the agent is. When the agent cannot help, or the caller
asks for a person, it **tells the caller first**, then the call is passed on. Everything is the
engine's, behind three seams (a phone call is a transport swap — §6.30):

- **Settings** (`handoff/config.js`) live in the existing `agent_configs.escalation` JSON (no new
  column; the backend later stores one more document next to the others):
  `{ enabled, contacts: [{id, role, name, phone}], whenCallerAsks, afterMisses 1–4, topics[], outsideHours:
  "callback"|"forward", announce: {en?, ur?} }`. Phones are stored in international form; ≤5 contacts; "enabled" with nobody to
  forward to is read as OFF and refused on save (`validation:handoff.*`, en + ur). **Phone numbers are never put in a
  prompt and never sent to a browser** (the chat route strips them; events carry ids only).
- **The decision is code, not the model** (`handoff/decide.js decideHandoff`, pure, one call per message from
  `respond()` via `handoff/turn.js planHandoff`; the model only WORDS it, `prompt.js buildHandoffInstruction`):
  1. the caller asks for a person (`asksForHuman`, en/ur/Roman Urdu) → hand off now (`asked`), to the contact whose
     role/name the caller mentioned, else the owner's first; 2. an owner topic word ("complaint") → hand off
     (`topic`); 3. **not understanding, counted in a row**: first time → the agent says so honestly and asks the
     caller to rephrase (`rephrase`); the Nth time (N = `afterMisses`) → hand off (`not_understood`, or
     `frustrated` when the caller said they are not understood / repeated themselves). A good answer, a greeting, a
     request being taken or a question the business PROFILE answers (hours, who are you) resets the count.
  4. closed hours + `outsideHours: callback` → NO transfer is promised (`unavailable`): the agent offers a call-back.
  "Not understanding" means: speech the recogniser could not read (voice only, below), a real question with nothing in
  the documents, the caller saying so, or saying the same thing again — all rule-based, zero model calls.
  State is `conversations.handoff_state` (migration `20261021120000_conversation_handoff_state`, hand-written, HNSW line
  removed), restored if the reply fails; a conversation already passed on is not forwarded twice (chat has no hang-up).
- **What the caller hears before a transfer is the CODE's, never the model's** (`handoff/announce.js`, pure). A real call
  was forwarded in silence: the model was told to announce the transfer and greeted the caller instead. Now the model
  is told to say ONE short acknowledgement and NOT to announce or name anyone, and `respond()` appends a fixed line
  for the person being called — "I'm connecting you to Ali, our Representative. Please stay on the line." — to the
  streamed, returned and stored reply (chat and voice alike; `result.handoff.announcement`). The owner may write their
  own line per language (`announce` {en?, ur?}, ≤200 chars, `{name}` and `{role}` the only placeholders — anything else
  in braces is refused, it would be read aloud); empty = the built-in line (Urdu in the passive, so it never depends
  on the voice's gender). A person with only a name or only a role still gets a natural sentence. If the first person
  does not answer, the session says so and announces the next ("Ali isn't available right now. I'm connecting you to
  Adan, our Senior…", `nextContactLine`); unheard speech that ends in a transfer says "I'm sorry, I couldn't
  understand." + the announcement. The console (Agent tab → Call forwarding) previews the line for every person with
  the same functions. Tests: tests/handoff-announce, voice-session, test:collect.
- **The transport places the transfer** — the seam Twilio fills: `transport.transfer(contact, { summary, reason,
  callId }) → Promise<{ connected: boolean, reason?: "busy"|"no_answer"|"failed" }>`, or, for a phone line that hands the
  whole ordered list to the network at once, `transport.transferInOrder(contacts, …)` (§6.30). `CallSession.performHandoff`
  waits for the announcement to finish playing, tries the contacts in order, and on `connected` ends the call as
  `transferred` (`END_REASONS.TRANSFERRED`); if nobody answers, or the transport has no `transfer`, it says a fixed
  line (`voiceLine("handoff_failed")`), clears the state and **the call carries on** so a call-back can be taken. The
  browser transport only SIMULATES (`SERVER.TRANSFER` → the console shows who, no number). `summary` is a few plain
  English lines for the person who picks up (reason, last things said, details already collected) — a phone
  transport can say it to them before bridging. Events: `handoff.requested` / `handoff.unavailable` (engine events,
  ids only) and, on the call timeline, `handoff.started/attempt/failed/completed/unavailable`.
- **Speech nobody could read** (`CallSession.onUnheard`, `UNHEARD.minSpeechMs` 1 s): a caller who really spoke and got
  an empty transcript used to be met with silence. Now: "Sorry, I didn't catch that" (fixed line, Urdu without gendered
  forms or Latin names), and a second time in a row `brain.noteUnheard` → hand off if the business set it up.

**Ending a call well** (`voice/config.js SILENCE`, `voice/closing.js`; tests in voice-session, voice-closing):
- **Never hangs up on silence without asking.** 15 s after the AGENT stopped talking (not from the caller's last word,
  never while the agent is thinking or speaking) → "Are you still there?"; 10 s more → a polite goodbye line, then the call
  ends (`idle_timeout`). Any sound from the caller cancels both. A caller who hangs up is simply the end. A caller who
  said "hold on" gets 60 s and then 20 s (`SILENCE.hold`, §6.24 turn-quality item 6).
- **A finished conversation ends itself — decided by rules, owner-controlled** (`voice/closing.js decideCallEnd`, pure;
  the words in `lib/phrases` CLOSINGS, en / ur / Roman Urdu). Per AGENT: `autoEndCalls` (default on) and
  `endCallDelaySeconds` (2–10, default 3) — migration `20261027100000_agent_call_ending`, hand-written, HNSW line removed;
  console: Agent tab → "Ending the call". The call ends when the agent's reply asked NOTHING and: the caller said goodbye
  in a short message (≤ 8 words: `intent.js` GOODBYE — `caller_goodbye`); or the agent's previous reply asked "anything
  else?" and the caller declined ("no thanks", "nahi shukriya", "بس" — `no_more_questions`; a plain "no" anywhere else is
  an answer, not a goodbye); or the agent itself closed ("…Have a great day!", "خدا حافظ" in its LAST sentence —
  `agent_farewell`). Never mid-request, after "hold on", during a transfer, on a failed or cut-off turn, or while the
  caller is talking. If the caller closed but the reply had no goodbye, the fixed `voiceLine("closing")` ("Thank you for
  calling. Goodbye.") is said first. Then: the agent's audio finishes → the owner's seconds of quiet → the call ends
  (`agent_goodbye`, event `call.ended_by_itself` with the trigger; `call.closing` logs the decision). Speech in that quiet
  stops the countdown; a cough or click that turns out to be nothing restarts it; anything real cancels it. Off = the
  caller hangs up (the silence check-in below still ends a silent line). On calls with the switch on, the prompt asks the
  model for ONE short thanks-and-goodbye sentence at that point and no further question (`CALL_ENDING_STYLE`).
- **Solution-oriented but never hurried** (`prompt.js HELPING_STYLE`, in every prompt): work toward an answer, a request
  noted or a person connected; one question at a time; never rush, interrupt or talk down; once the need is met, ask once
  whether there is anything else, then close warmly.

**The marker that leaked** (`collect/marker.js`): a real call read aloud "…the treatment cost. [[START code]]May I have your
name?" — the model put the start marker MID-reply and copied the placeholder "code" from the instruction. The filter now
removes a marker ANYWHERE in the reply, whatever the stream chunking (a lone "[" is held only until it is clear it is not a
marker), tolerates `[START x]`, and the prompt spells a real code per request type (`[[START appointment]]`), never a
placeholder. An unknown code starts nothing (`respond()` checks it against the request types the business has).

**Verified:** `npm test` (539), `npm run test:collect` (handoff end to end on the real DB: asked, rephrase→handoff, topics,
reset in a row, unheard, closed hours, failed reply restores state, the mid-reply marker). **Not verified:** a real phone
transfer through a real Twilio account (§6.30 is verified against a fake one); the real model's wording of the handoff announcement in Urdu; how often the
"nothing in the documents" signal fires on real BUSINESS documents (a business with thin knowledge will hand off more —
`afterMisses` is the owner's dial).

### 6.27 Several agents per tenant

**The model (decided with the owner):** the AI engine is ONE brain (`respond()`). An **agent** is one setup the brain
answers with — one `agent_configs` row: business name, purpose, tone, hours, reply language, voices, what it collects,
who it forwards calls to. A tenant has **one or more** agents (a restaurant chain: one per branch; a call centre: one per
line or client). Later each phone number points to exactly ONE agent, and an agent may have many numbers (§9.2) — that
mapping is the backend's (docs/handoff-to-backend.md B11). **Knowledge is one library per tenant; each document is
shared by every agent or limited to some** (§6.28).

**Rules that must not drift:**

- **The default agent keeps every single-agent caller unchanged.** `agent_configs.default_for = tenant_id` marks it — a
  plain UNIQUE column (NULLs never collide), so the database guarantees one default per tenant without a partial index
  Prisma could not see (§6.1). Anything that names no agent (`?agentId=` omitted, `getAgentConfig(tenantId)`) is the
  default agent. A tenant that has saved nothing has NO row and gets `DEFAULTS` (`agentId: null`); a READ never creates
  a row (`listAgents` lists an unsaved default as `id: null` — the console's tenant box would otherwise leave an agent
  behind for every half-typed tenant id); the first SAVE creates it (`ensureDefaultAgent`, race-safe on the unique).
- **Every lookup is scoped by tenantId AND agentId together** (`findFirst({ id, tenantId })`): another tenant's agent id
  is `AgentNotFoundError` → 404, never served, saved, renamed or copied (test:agents checks all four).
- **A conversation is held with ONE agent, fixed when it starts.** `conversations.agent_id` is written by the adapter
  (chat route; `CallRecorder.open` for voice); the adapter passes the same id to `respond()`, which REFUSES a mismatch
  (throws) rather than answer with another agent's persona, checklist or forwarding list. The chat route treats a
  conversation id of another agent as a new conversation. `agent_id` NULL (rows from before agents, or a tenant with no
  row yet) = the default agent: lists of the default agent include them (`agentScope(agentId, includeUnassigned)`).
- **A voice call resolves "the default" to an id at pick-up** (`CallSession.start`), so a call keeps its agent even if the
  owner moves the default mid-call. The agent is SIGNED into the voice ticket (`ticket.js` claim `a`), so a browser
  cannot swap agents after `/api/voice/session` checked it.
- **Archived, never deleted.** Calls, conversations and requests point at agents. Archived = stops ANSWERING (chat and
  voice refuse it with 409, `requireAgent({ serving: true })`; a call whose agent was archived after its ticket fails
  set-up) but its settings and history stay readable. The default cannot be archived; an archived agent cannot become
  default — something must always answer a request that names no agent. Moving the default is one transaction that
  clears the old one FIRST (the unique would collide otherwise).
- **`uiLocale` is the TENANT's** (the dashboard language): it lives on the default agent; saving it through any agent
  writes the default row, and every agent reports it. Everything else is per agent.
- **A new agent starts as a COPY** of another agent's settings (`copyFrom`, default: the default agent) — branches and
  lines share most settings; a blank agent would make the owner retype them. Its `collectVersion` restarts at 1.
- **Names** are trimmed, ≤60 chars, unique among the tenant's ACTIVE agents (case-insensitive, checked in code — an
  archived agent's name can be reused). The default may stay unnamed (the console shows the business name).
- **Limits:** the engine's safety cap is 25 active agents (`MAX_AGENTS_PER_TENANT`); a PLAN's limit belongs in
  `registry.js assertCanAddAgent()` — same "edit only this function" rule as `assertTenantServiceable()` (§4).
- **Cache:** keyed per (tenant, agent); `invalidateAgentConfig(tenantId)` clears every agent of the tenant, because a
  change to one (default moved, dashboard language) changes what another reads.
- **Events carry `agentId`** (`record.submitted`, `handoff.requested/unavailable`), and `call_logs.agent_id` /
  `records.agent_id` exist, so usage and reports can be split per agent (and per number, with telephony).
- **Migration** `20261022120000_multiple_agents_per_tenant` (hand-written, HNSW line removed): drops the one-row-per-
  tenant unique, adds `name`/`status`/`default_for`, adds `agent_id` to conversations/call_logs/records, and makes every
  existing row its tenant's default agent, stamping existing conversations, calls and requests with it.

**API** (all optional `?agentId=`; without it, the default agent for settings/serving and every agent for lists):
`GET/PUT /api/agent-config`, `GET/PUT /api/collect`, `POST /api/chat`, `POST /api/voice/session`,
`GET /api/records`, `GET /api/voice/calls`; and `GET/POST /api/agents`, `PATCH /api/agents/:id`
(`{ name?, status?, makeDefault? }`). Route-side parsing and errors live in `tenant/agent-request.js` only.

**Console:** an agent bar above the tabs (`AgentPicker`); every tab — settings, what it collects, calls, chat — shows the
picked agent; switching agents starts a new chat conversation and hangs up a live call. Knowledge is one library, each
document shared or limited to some agents (§6.28).

**Verified:** `npm test` (543 — incl. tickets carry the agent and cannot be re-signed, a call uses its agent for config,
call record and every turn, the default resolved at pick-up, an archived agent does not answer), `npm run test:agents`
(the rules above against the real DB, with the real `respond()` and a faked model), `test:collect` unchanged, the HTTP
routes by hand on a dev server, and the console driven in a browser (create → copy → edit → switch) in English and Urdu.
**Not built:** buying phone numbers (backend, B11); per-agent analytics
screens.

### 6.28 Knowledge per agent — one library, each document shared or limited

**The model (decided):** a tenant keeps ONE knowledge library (titles stay unique per tenant, replace-not-append is
unchanged, §6.10). Each DOCUMENT is either **shared** — every agent of the tenant answers from it (the menu, the
policies) — or **limited** to the agents the owner picks (the Dublin branch's page). Shared is the default and what every
document was before, so a tenant that never limits anything behaves exactly as before.

**Why per DOCUMENT and not "agent X uses documents [...]":** a new agent (a new branch) must automatically know
everything shared and must NOT inherit another branch's page. Per-document availability gives exactly that with no
step for the owner; a per-agent list would make a new agent see everything (other branches included) or nothing.

**Rules that must not drift:**

- **Storage:** `knowledge_source_agents (source_id, agent_id, tenant_id)` — PK `(source_id, agent_id)`, both foreign
  keys `ON DELETE CASCADE`. No rows = shared; rows = only those agents. Migration
  `20261023100000_knowledge_per_agent` (hand-written, HNSW line removed, changes no existing answer).
- **The rule is in ONE place:** `lib/agent/knowledge-rules.js canAgentUse` (pure — the console imports the same rule
  for its "used by this agent" flag) and its SQL twin `lib/agent/knowledge-access.js agentAccessSql`
  (`AND (NOT EXISTS link OR EXISTS link for this agent)`, the agent id a bound value). tests/knowledge-access pins
  that they agree.
- **Retrieval FAILS CLOSED.** `retrieveRelevantChunks({ agentId })` with no agent searches SHARED documents only — the
  most a caller that forgot the agent can get, never another agent's page. Only the debug/eval paths see everything,
  and they must say `wholeLibrary: true`. `respond()` passes `config.agentId`; `retrieveForTurn` passes it to EVERY
  search of a turn (raw, rewritten, the empty-first-pass retry). Membership is still `MAX_DISTANCE` alone (§6.3) among
  what the agent may use; the HNSW iterative scan (§6.1) absorbs the stricter filter.
- **When availability changes:**
  - a NEW document's links are written right after its row, BEFORE any chunk exists — never searchable by an agent it
    is not meant for, not even for a moment;
  - a REPLACE that names agents swaps them in the SAME transaction as the new chunks (§6.10's swap); a replace that
    does not mention agents KEEPS them — re-uploading the Dublin page must never quietly hand it to every branch (the
    console's "All agents" choice therefore sends nothing);
  - changing availability alone (`PUT /api/knowledge/:id { agents }`, `setDocumentAgents`) re-embeds NOTHING — same
    chunk rows (test:agents checks the ids);
  - retry and re-embed never touch it; deleting a document or an agent removes its links (cascade).
- **Input** (`normalizeAgentList` + `validateAgentsForTenant`, via `readAgentsInput` in every route): `null`/`"all"` =
  shared, a list = only those (deduplicated, ≤25), omitted = leave as it is. An EMPTY list is refused (it is a form sent
  before anything was ticked, not "nobody"). Every id must be an agent of THIS tenant — no cross-tenant links; archived
  agents are accepted (a branch closed for now) and the console warns when no ACTIVE agent uses a document.
- **A copied agent inherits settings, never another agent's limited documents** (`createAgent` copies `agent_configs`
  only). It uses every shared document from its first call.
- **The search debug route** (`/api/knowledge/search`): the real paths search what an agent would (the named agent, else
  the default — exactly like the agent); the raw path the whole library unless `agentId` is named.

**API:** `GET /api/knowledge[?agentId=]` → each row has `agents` (null = shared) and, with `agentId`, `usedByAgent`;
`POST /api/knowledge` (typed, url, multipart — a JSON string field `agents`) and `PUT /api/knowledge/:id` take `agents`.
Errors: `validation:knowledge.agentsInvalid|agentsEmpty|agentsTooMany|agentsUnknown` (en + ur).

**Console (Knowledge tab, shown once a tenant has two agents):** "New documents are for: All agents | Only <agent>";
"Show: All documents | Documents <agent> uses"; each row says "All agents" or "Only: Dublin, London" with a Change
editor; a document the picked agent does not use is dimmed and says so. "Select all" only selects what is on screen.

**Verified:** `npm test` (554 — the rule, the input, the SQL shape, and that every search of a turn carries the agent),
`npm run test:agents` (71 against the real DB: the filter for an agent / the default / no agent / the debug path,
availability at create / replace / alone without re-embedding, cascade, copy, cross-tenant ids, and `respond()` giving
Dublin's page to Dublin and never to London asked the same words), the HTTP routes by hand, and the Knowledge tab
driven in a browser. **Not verified:** retrieval quality with a real embedding model (no key in the build sandbox — the
filter is independent of the vectors, the ranking within it is unchanged).

**Every per-agent setting, audited end to end (test:agents, real `respond()`):** call forwarding (Dublin passes the
caller to its own person, London has none), what the agent collects (one agent takes requests, the other does not), the
reply language, the opening hours, the forwarding contacts, the call greeting and the recording switch (§6.24), ending the call by itself and its wait (§6.26) each
follow the AGENT, and a generic opener is searched with that agent's own business name (§6.20); the dashboard language
follows the tenant (§6.27). Records and calls carry the agent (§6.27). (test:agents: 93 checks since the business summary.)

### 6.29 Phone numbers — "this number was dialled: which business, which agent?"

**The model (decided with the owner):** a business has one or more phone numbers; **each number rings exactly ONE
agent, and an agent may have many numbers**. An inbound call identifies its business AND its agent by the number that
was dialled — never by anything the caller supplies (§9.2). Buying, porting, releasing and billing numbers is the
BACKEND's (§4, handoff B11); the engine owns the lookup and everything on the call, including the Twilio webhook that
uses it (§6.30). This is the part that has to be right for that to be safe.

**The seam:** `tenant/registry.js resolveDialledNumber(dialled)` → `{ ok, tenantId, agentId, numberId, e164 }` or
`{ ok: false, reason }`. Today it reads the stand-in store (`standins/numbers.js findNumberForRouting`, table
`phone_numbers`); when the backend's `GET /internal/numbers/{e164}` exists, the read inside this ONE function changes
and nothing else does. Its callers: the console's "call as if dialling" (`POST /api/voice/session?to=`),
`GET /api/numbers/lookup?to=`, and the Twilio webhook (`/api/telephony/twilio/voice`, §6.30).

**Rules that must not drift:**

- **Refuse, never guess.** Reasons (`telephony/routing.js ROUTE_REFUSALS`): `invalid_number`, `unknown`, `released`,
  `unassigned` (linked to no agent), `agent_archived`, `tenant_unserviceable`. A refused number is never sent to "some"
  agent of the business, and never to another business. A real caller hears `voiceLine("not_in_service")` (en + ur) and
  the call ends; the reason goes to the log.
- **E.164 only** (`toE164`): provider webhooks send it; people typing may add spaces, dashes, brackets or `00`. A number
  WITHOUT its country code is refused (`needsCountryCode`), not guessed — "020 …" is London to a Briton and a stranger's
  line elsewhere.
- **One active number = one business**, enforced by the database: `phone_numbers.active_e164` is UNIQUE and set to the
  number while active, NULL once released (the `default_for` trick of §6.27 — no partial index Prisma cannot see).
  A released number keeps its row (calls point at it) and can be added again, by anyone; the lookup then says
  `released` only while nobody holds it.
- **A number rings an ACTIVE agent of its OWN business** — checked on add and on re-link. An agent that numbers still
  ring cannot be archived (`agents.hasNumbers`); move them first. If an agent ends up archived anyway, its numbers refuse
  (`agent_archived`) rather than re-route.
- **Cached ~30 s per process** (`telephony/route-cache.js`); every change through `standins/numbers.js` drops the
  number's route at once, so re-linking takes effect for the NEXT caller. Serviceability (`assertTenantServiceable`) is
  re-checked on EVERY call and never cached, so a suspension is immediate. A call already in progress keeps the agent it
  was answered by.
- **The call records its line:** `call_logs.to_number` + `phone_number_id` (and `agent_id`), signed into the voice
  ticket (claims `l`, `d`) so a browser cannot forge which number a call came in on. `GET /api/voice/calls?numberId=`
  lists one number's calls — per-number reports and per-number billing start here.
- **The console's "call as if dialling"** (Call tab) uses the REAL lookup: the number, not the agent picker, decides
  who answers — the closest thing to a phone call without Twilio. It only dials the console tenant's own numbers;
  another business's number reads "unknown" there and is never connected.

**API** (stand-in dashboard, §4): `GET/POST /api/numbers`, `PATCH /api/numbers/:id` (`{ agentId?, label?, status:
"released" }` — no DELETE), `GET /api/numbers/lookup?to=` (tenant-agnostic on purpose: the number alone decides; a
refusal is a 200 answer). Errors `validation:numbers.*` and `numbers.route.*` (en + ur). Kinds: `purchased` and
`forwarding` (the hidden number a business forwards its own line to) route the same.

**Verified:** `npm test` (567 — E.164, every routing decision, the cache, the signed line, the not-in-service line, the
call recording its number), `npm run test:numbers` (32 against the real DB: storage format, every refusal, re-link
effective for the next caller despite the cache, one business per active number, release and re-adding elsewhere,
isolation, the archive guard, a suspended business, a call's number and per-number counts), the HTTP routes by hand, and
the Numbers and Call tabs driven in a browser. The Twilio webhook that uses this lookup is §6.30. **Not built:** buying
numbers (backend), forwarding-number setup help.

### 6.30 Phone calls — the Twilio webhook and the phone transport (the engine's half of telephony)

**What exists:** a call to a business's Twilio number reaches its agent. Twilio asks our **webhook** "a call came in on
number X, what now?"; we verify it is really Twilio, find the business and agent from the dialled number (§6.29), and
answer with TwiML that opens a **Media Stream** to the voice gateway; the gateway's **phone transport** carries the call's
audio (8 kHz μ-law ⇄ the 16 kHz the speech models use) into the same `CallSession` the browser console uses (§6.24). The brain,
the greeting, barge-in, request-taking, call ending and everything else are unchanged — a transport swap, as designed.

```
caller ─ phone network ─► TWILIO ─POST /api/telephony/twilio/voice (signed)─► APP: verify → resolveDialledNumber → ticket
                            │  ◄──────────── TwiML <Connect><Stream url="wss://gateway/twilio"> + ticket ───────────┘
                            └─ Media Stream (wss) ─► GATEWAY /twilio: start {ticket} → CallSession(transport twilio)
                                                      μ-law 8 kHz ⇄ VAD → STT → respond() → TTS ⇄ frames of 160 bytes
```

**Who owns what (agreed split, §4):** the Twilio ACCOUNT, buying/porting/releasing numbers, billing and where recordings are stored
are the BACKEND's (Haseeb, handoff B11). The ENGINE owns everything on the live call: this webhook, the stream, the transport,
the lookup and the call record. Why the webhook is the engine's and not the backend's: it must answer in milliseconds and its
only inputs are the dialled number (→ the lookup seam, which reads the backend's data when it exists) and the ticket secret that
the gateway shares with it. The deployment needs `TWILIO_AUTH_TOKEN` (verifies signatures), `TWILIO_WEBHOOK_BASE_URL` (the public
https origin; falls back to `PUBLIC_APP_URL`), `VOICE_GATEWAY_PUBLIC_URL` (where Twilio opens the stream) and, for transfers,
`TWILIO_ACCOUNT_SID` — all in `.env.example`; `GET /api/telephony/twilio/setup` and the Numbers tab say what is missing (names
only) and show the address to paste into the number's "A call comes in" setting (HTTP POST). One Twilio account per deployment
is assumed; per-business subaccounts would make these per-tenant values the backend hands over.

**Rules that must not drift:**
- **A webhook that is not verified decides nothing.** `readVerifiedTwilioRequest` checks `X-Twilio-Signature` (HMAC-SHA1 of the
  URL + sorted POST parameters, keyed with the Auth Token — `twilio-signature.js`, pinned to the example in Twilio's docs)
  against a URL built from OUR configuration plus the request's path and query, never from its Host header. No signature / wrong
  signature → 403, not configured → 503 (unsigned requests are never accepted just because nothing is set), body > 64 KB → 413.
  These routes are NOT behind INTERNAL_API_KEY — Twilio cannot send it; the signature is their guard. The routes are
  `/api/telephony/twilio/{voice,transfer,whisper}` (+ `setup`, internal-key guarded).
- **The tenant, the agent and the number come only from the dialled number** (`resolveDialledNumber`, §6.29): a refused number
  (unknown / released / unlinked / archived agent / suspended business) hears `voiceLine("not_in_service")` — English, in Twilio's
  own voice, because there is no agent to speak for — and is hung up on; the reason goes to the log, never the numbers. Every
  answer once verified is a 200 with TwiML (a non-2xx makes Twilio say its own "application error").
- **The stream's trust is the ticket** (`voice/ticket.js`, the same signed single-use one-minute hand-off as the browser's): it
  names the tenant, agent, the number dialled and now who is calling (`f`, only a real E.164 number — "anonymous"/SIP ids are
  not recorded). The gateway re-checks `assertTenantServiceable` and the call limits. A refusal can only be a close: the call then
  moves on to the TwiML's next verb, a hang-up.
- **A per-business limit on call starts** (120/min, `INBOUND_LIMIT`): the signature proves a request is real, not that it is new.
- **The gateway has two sockets on one port** — `/call` (browser) and `/twilio` (phone) — via `noServer` and a hand-written
  upgrade (ws's `path` option would make each server destroy the other's connections). Phone sockets get no heartbeat: Twilio
  ends the stream itself (`stop`), and `maxCallMs` and the silence check-in end anything else.
- **Audio at the edge** (`audio.js`, pure, tests/voice-units): G.711 μ-law (silence 0xFF, clipped not wrapped); inbound 20 ms
  frames are up-sampled with a STREAMING 2× windowed-sinc filter that keeps the previous frame (a click at every frame edge
  otherwise); outbound, a spoken piece is resampled from the voice's 22–24 kHz with a windowed-sinc low-pass — measured: a 6 kHz
  tone is removed, not folded into the voice — encoded and sent as 160-byte frames. Twilio queues what it is sent and plays it in
  real time, so the session's own estimate of when audio ends (`audioPlaysUntil`) is "the agent is talking", as on every
  transport; `clear` on barge-in. Only the caller's track is read.
- **A transfer is "replace this live call's instructions with a `<Dial>`"** (`twilio-rest.js` → Twilio REST; the auth token never
  logged). The session hands the WHOLE ordered list to a phone transport once (`transport.transferInOrder`, preferred over the
  per-person `transfer` of the browser) after the announcement has played; Twilio rings the first person for 20 s, reading them
  a summary first (`<Number url=…whisper>`); when they do not pick up it asks `/transfer`, which rings the next — the state (the
  list, the position, the summary) travels in a SIGNED token in the URLs (`signed-token.js`, kind-tagged, 10 min), so no server
  memory is involved and a forged token rings nobody. `connected: true` means the call has LEFT the agent. If Twilio refuses or is
  unreachable the call stays with the agent, which says nobody is available (§6.26). **Known limit:** once a transfer is placed the
  call cannot come back to the agent: when nobody answers, the caller hears a fixed English line ("nobody is available… please call
  again later") and the call ends, so no call-back can be taken in that case. Twilio's voice has no Urdu, so the summary and that
  line are English.
- **Not built / not decided:** recording (the per-agent switch and the greeting's notice exist; where audio lives is the backend's);
  DTMF; marks for exact playback (the estimate is used); VAD and barge-in thresholds tuned on REAL phone audio; capacity refusals
  are silent (a full gateway closes the socket).

**Verified:** `npm test` (the signature against Twilio's published example, tokens, TwiML escaping, every refusal, the transfer chain,
the REST call, the verified-request reader, the transport's wire format and transfer, the session's ordered transfer), and
`npm run twilio:smoke` — a fake Twilio against the REAL app and gateway and the real speech models: a wrong or missing signature
is refused, an unknown number is told "not in service", a signed call to a real number is answered with a stream, the greeting
arrives as 20 ms μ-law frames, a spoken question sent as 8 kHz μ-law is understood by the recogniser and answered out loud, and
the call is recorded as transport `twilio` with the numbers and the Twilio call id. **Not verified:** any of it through Twilio's
real network (no account in the build sandbox) — number configuration, the stream's real timing, carrier audio quality, a real
transfer. The first real calls are where the VAD/barge-in thresholds get tuned: a speech onset that starts at the very first
sample was clipped by the VAD in the smoke test (a natural lead-in is fine).


---

## 7. Languages

**Two languages, everywhere: English and Urdu.** Italian and Arabic were removed on purpose
(product decision: the market is Pakistan plus English-speaking countries) — their catalogs,
voices, OCR data, stop-word lists and the Italian test document are gone from the repo. Do not
bring them back piecemeal; a new language is a whole-stack change (UI catalog, voices, STT,
stop words, language detection, prompt wording) and should be designed as one.
Nothing user-facing is a hardcoded string — not a heading, not a button, not a validation message.

**⚠️ TWO SETTINGS. They answer different questions — never merge them.**

| Setting | Values | Controls |
| --- | --- | --- |
| `agent_configs.uiLocale` | `en` \| `ur` | The **interface** — every dashboard screen (Urdu renders right-to-left). One per TENANT (kept on the default agent, §6.27) |
| `agent_configs.replyLanguage` | `en` \| `ur` | What the **agent says** — per agent |

The two are independent: a Karachi business can run an English dashboard while its agent
answers in Urdu.

**The rule the owner set: understand both, answer in the chosen one.** With `replyLanguage =
ur` the agent understands Urdu AND English (and Urdu with English words mixed in, the way
people actually talk) and always replies in Urdu; with `en` it understands both and replies in
English. Concretely:
- **There is no `auto`.** An older stored `auto` (or `it`) degrades to the default, `en`
  (`tenant/config.js`). `isReplyLanguage()` accepts only `en`/`ur`.
- **The prompt** (`prompt.js` language section) states the rule in those words, and says the
  customer's words are a transcript on the voice channel.
- **Speech recognition no longer depends on the reply language** (§6.24): a caller may speak
  either language to either agent, so the recogniser must hear both.
- **`buildSystemInstruction()` takes no `locale` parameter** — reply language comes from
  `config.replyLanguage`; interface language is presentation and must never leak into a prompt.
- **UI language precedence:** a saved `uiLocale` outranks `Accept-Language`
  (`tenant/ui-locale.js` is the one place that decides it, for every route).
- **Urdu text is matched with Unicode-aware edges, never `\b`** — JavaScript's `\b` does not
  see Arabic-script letters as word characters (`collect/phrases.js` shows the pattern). Roman
  Urdu ("mujhe appointment chahiye") is understood by the collection rules too.
- `ar` is gone; its RTL helpers stay because Urdu needs them (every layout uses logical CSS).
- `npm run i18n:check` enforces key **and** placeholder parity for `en` and `ur` and runs on
  build. Translation rot is silent; do not weaken this to unblock a build.
- Plurals go through `Intl.PluralRules`.
- **Urdu is not native-reviewed**, and the Urdu retrieval/LLM quality has not been measured
  (§8 limitations).

---

## 8. What works today

**End to end, verified against a live database:** give the agent documents →
ask it a question → get a grounded, correctly-sourced answer, streamed, in the
right language, with history persisted per tenant.

| Area | State |
| --- | --- |
| RAG retrieval | ⚠️ hybrid — vector search + keyword RRF re-rank + heading diversity (§6.3). Measured on the REAL pipeline against the full `test-docs/` corpus with `npm run eval:real` (saved baseline, 53 standalone questions): **hit@1 74% / hit@3 81% overall** — 92% on direct factual questions, 64% on loosely-phrased ones, 100% on cross-language, **0% on generic "tell me about your company" openers**; off-topic rejection 88% (one leak). Full table in §6.3. (`eval:retrieval`'s old "100% hit@1, MRR 1.000" measured a fixture-only, non-hybrid retriever and is not what this row reports.) |
| Business profile ("who are you?") | ✅ an `ABOUT THIS BUSINESS` block (name, purpose, hours, and the owner-approved AI summary of the documents they chose — general facts, never prices) is always in the prompt, so the agent answers who-we-are without retrieval; it does not enumerate products it was never given (§6.20). Generic openers are recognised by rule in English, Urdu and Roman Urdu (word files in `lib/phrases`, 15/15 on the eval set) and searched as "<business>: <question>"; ⚠️ the retrieval gain is NOT measured yet (needs embeddings) |
| **Call greeting** | ✅ per agent: the owner's own words or a built-in greeting that says the caller is speaking with an AI assistant, and that the call is recorded only while the agent's recording switch is on; warnings (never refusals) when the owner's text leaves a notice out (§6.24). Recording itself is not built |
| Keyword half | ✅ language-aware (`english`/`simple` per document — Urdu script is `simple`, precomputed `tsvector`) — ⚠️ but it ANDs every query term, so sentence-length questions get almost no keyword signal in any language (§6.3) |
| Multi-tenant vector search | ⚠️ one shared HNSW index filters by tenant AFTER the graph walk; guarded with per-transaction iterative scans, asserted by `db:check`; the guard has a ceiling (§6.1) |
| Embedding scheme & re-embed | ⚠️ the machinery is built and tested (`embed-scheme.js`, `npm run reembed`, batching, role/`taskType` plumbing — §6.2), but **no new scheme is adopted**: measuring one needs ~800 embedding texts and the free quota has not allowed it (§8 limitation 4) |
| **Follow-up questions** | ✅ "and the Pro one?" is rewritten into a standalone query before retrieval — 31% → 100% hit@1 on 16 follow-ups, off-topic still rejected (§6.19). ⚠️ costs ~1–1.5s per triggered turn, too slow for the voice budget (§9.2); precise trigger + circuit breaker + optional faster model built, NOT yet measured (§6.19) |
| **Voice calls (browser)** | ✅ Call button in the console → greeting → speak → grounded spoken answer; barge-in, failure apology; every call/turn/event stored and shown back (§6.24). Natural (Kokoro) and fast (Piper) voices, male and female, US/UK English and **Urdu**, chosen per business in the console with ▶ preview. Progressive chunking; the silence inside a sentence is down from ~300 ms to ~100–135 ms at each join (engine quiet trimmed, no pause between pieces of one sentence, no cut after "about/the/two" — measured with `voice:gaps`); a slow machine still has gaps and logs `tts.slow`. Pauses: a sentence cut by a pause is answered as one message (also when the first half sounded finished), "hold on" gets a longer wait, and pause talk never enters the conversation. ⚠️ ~3.1–3.8 s end-of-speech → first word with the natural voice on lucky free-tier Gemini calls — the free tier's 3.5–10 s first token is the main problem; Groq provider built, NOT yet measured (no key). Urdu callers are understood only with `GROQ_API_KEY` (recognition no longer depends on the reply language, §6.24). Phone calls through Twilio are built (§6.30), verified against a fake Twilio only |
| Heading-aware chunking | ✅ verified on tables and multi-section documents; label/value & URL lines no longer misdetected as headings (§6.4) |
| Relevance threshold | ✅ measured at 0.43; off-topic questions return nothing |
| Multi-file upload | ✅ one job per file; bad files rejected individually |
| PDF / DOCX / TXT / MD / CSV | ✅ extracted; Word heading levels survive into chunk headings |
| **OCR for scanned PDFs** | ✅ character-perfect on an image-only PDF |
| Background jobs + live progress | ✅ real percentages, stage labels, stale-job reaping that no longer flaps a legitimately-queued job (§6.6) |
| **Job cancellation** | ✅ cooperative cancel of a queued/processing import, with correct rollback of the row/chunks/Cloudinary file (§6.14) |
| **Retry a failed import** | ✅ re-embeds already-stored content, no re-upload — offered only for transient errors (§6.15) |
| **Original file storage** | ✅ Cloudinary, cleaned up on delete/replace/cancel, never touched by retrieval (§6.13) |
| Website crawling | ✅ SSRF defences verified against 8+ attack vectors, now including DNS-rebinding pinning and cross-origin-redirect blocking (§6.9) |
| Replace / edit / rename / delete | ✅ enforced server-side; replace now confirmed client-side first and rolls back cleanly on failure (§6.10) |
| Conflict surfacing | ✅ agent names the discrepancy rather than guessing |
| **Languages** | ✅ English + Urdu only, everywhere (§7): UI (Urdu is right-to-left), agent replies, voices, speech recognition. The agent understands both whichever it answers in. Italian/Arabic/`auto` removed. ⚠️ Urdu is not native-reviewed and Urdu retrieval/LLM quality is unmeasured |
| **Phone numbers** | ✅ the lookup "dialled number → business → agent" (`registry.js resolveDialledNumber`): E.164, one number = one agent, refuses unknown / released / unlinked / archived / suspended, cached and dropped on change; calls record their number; the console can call "as if dialling" a number (§6.29). ⚠️ the numbers themselves are a stand-in (buying them is the backend's). The Twilio webhook and phone transport are built (§6.30) and verified against a simulated Twilio, not yet a real one |
| **Several agents per tenant** | ✅ each agent has its own settings, checklist, call forwarding, voice and language; chat, calls and requests are stamped with their agent; a default agent keeps one-agent tenants unchanged; archive, rename, make default; console agent picker (§6.27). Knowledge: one library, each document shared or limited to some agents, retrieval scoped to the agent and failing closed (§6.28) |
| **Taking requests** | ✅ the owner chooses what the agent collects (checklist, per request type, industry presets, custom fields); a deterministic engine asks, validates, reads back and saves a `requested` appointment/call-back/order with a reference; orders take only dishes on the owner's menu, pickup or delivery (address only for delivery); works on chat and voice, English and Urdu; "Collected" tab lists them (§6.25). The AI never books. Backend parts are stand-ins (`docs/handoff-to-backend.md`) |
| Test chat (SSE streaming) | ✅ `/api/chat`; each reply shows which model answered and which document(s) it was grounded in (debug metadata only, never spoken) |
| **User-facing errors** | ✅ raw provider errors (quota JSON blobs, etc.) are classified and translated before display (§6.16) |
| Console UI | ✅ upload/write/crawl as three top-level actions; write/edit share one modal + CodeMirror editor; multi-select bulk delete; every action button disables while its own request is in flight |
| **Tenant serviceability + abuse limits** | ✅ every serving/mutating route gates on `assertTenantServiceable()`; tenantId shape validated at the boundary; chat has a two-layer rate limit + message-length cap; uploads have a per-request file-count cap (§6.18) |

### Limitations — be honest about these

1. **Telephony is built but untried on a real line.** Voice calls work from the browser (§6.24) and through
   Twilio (§6.30: webhook, signature check, phone transport, ordered transfer), proven against a simulated Twilio with the
   real app, gateway and speech models — never through Twilio's network (no account in the build sandbox). VAD, barge-in and
   latency on real phone audio are untuned; a transfer nobody answers cannot return to the agent. **Voice latency is ~3–4 s to first word on a good free-tier
   call and up to ~10 s on a bad one**, because Gemini's free tier takes 3.5–10 s to its first
   token (§6.24). The ~800 ms target needs a fast LLM (Groq — built, needs a key) and probably
   the fast voice tier.
2. **No tool execution.** The agent collects booking details (§6.25) and saves them as a
   *request* a person confirms; it cannot book, check a calendar, or change an existing
   booking. Guarded so it never claims otherwise (§6.11). No WhatsApp/SMS confirmation is sent.
3. **Free-tier model quotas — two SEPARATE caps, both hit in practice.**
   Chat is ~20 requests/day *per model*; switching `GEMINI_CHAT_MODEL` moves to
   a fresh quota. Embeddings are a different cap
   (`EmbedContentRequestsPerDayPerProjectPerModel-FreeTier`, ~1000/day) — easy
   to exhaust during active testing (a few multi-chunk uploads plus eval runs
   in one session is enough), and every ingest and every chat reply needs at
   least one embedding call, so hitting it stops BOTH uploads and retrieval,
   not just chat. **It is counted per TEXT, not per request** (probed: batching
   saves latency, not quota — §6.20), and the window appears to roll rather than
   reset once a day, so exhaustion can last a full day. `humanizeError` (§6.16)
   shows it as a friendly "usage limit" message; the underlying error names
   which of the two quotas it is. OpenRouter's free Gemma pool has never once
   responded. **A paid key is required before any demo** — and before the
   embedding work in the next item can finish.
4. **Embedding-side work that is built but not measured, because of item 3.**
   The document-title prefix and Gemini `taskType` are not adopted; no
   re-embed has been run; `MAX_DISTANCE` is the 0.43 measured on the original
   scheme (§6.2, §6.3); the saved `eval:real` baseline predates
   `report_phrasings` and the last three short off-topic follow-ups (§6.19). The
   once-only sequence is written down in §6.20.
5. **Retrieval gaps, measured (§6.3, §6.20).** Generic overview openers retrieve
   nothing (0% hit@1; the profile covers the answer, not the retrieval);
   loosely-phrased questions are 64% hit@1; the keyword half is silent for 88% of
   questions (AND query) — the OR fix is built and OFF, awaiting `eval:real` (§6.22); one off-topic question leaks
   ("flight change fees" → the refund policy, 0.397).
6. **Follow-up resolution costs ~1–1.5s a turn** (an extra model call), too slow
   for the ~800ms voice budget (§6.19, §9.2). Mitigated, NOT measured: a precise trigger
   (1 of 71 standalone questions now fires, was 10), a circuit breaker that stops paying
   3s per turn when the provider is down, an optional faster `GEMINI_REWRITE_MODEL`, and an
   OFF speculative-search flag. The remaining cost on a genuine follow-up is one rewrite
   call; whether it fits the voice budget needs a real measurement.
7. **Shared HNSW index** — tenant-filter starvation is guarded per transaction but
   capped by `hnsw.max_scan_tuples`; past that, per-tenant partitioning (§6.1).
   At today's few hundred chunks the planner does not even use HNSW.
8. **Unit tests cover the pure logic only.** `npm test` (tests/, 732 cases) pins
   chunk.js, query.js's trigger heuristics, prompt.js, crawl.js's address/HTML
   handling, i18n, jobs.js (stubbed prisma), extract.js's pure helpers,
   `rankCandidates`, and the voice channel: the whole `CallSession` flow with faked
   speech/brain/recorder (greeting, turns, barge-in, failures, ordering, hang-up), sentence
   chunking, intent, tickets, PCM and the wire format. The real speech models are covered by
   `npm run voice:smoke`, not by `npm test`. What needs Postgres runs in the DATABASE suites, with the
   models faked: `test:collect`, `test:agents`, `test:numbers`, `test:reembed` (they cover `respond()`,
   `ingestDocument`, the retrieval SQL's filters, the stand-ins and the lookup). Still not covered by any
   automatic test: the route handlers themselves (checked by hand over HTTP), anything with a REAL model
   (`rewriteQuery` quality, wording, retrieval quality — the evals and `test:openrouter`), and real audio.
9. **In-process state** — job queue, caches, and the rate limiter (§6.18).
   Multi-instance needs Redis; N instances currently means N× the rate limit
   (chat: 60/min per tenant, 5 per 10s per conversation), same caveat
   `rate-limit.js`'s own header states. The voice gateway's call limits and used-ticket
   set are per gateway process too (§6.24).
10. **Urdu is not native-reviewed**, and no Urdu retrieval or LLM-answer numbers exist yet: the saved `eval:real` baseline predates the language change, and the former Italian questions are now Urdu ones that have never been scored (§6.3 note).
11. **No per-tenant BUSINESS limits** (max documents, storage quota, plan
    tiers) — that is the partner's billing/plan system (§4), not built yet.
    What DOES exist since §6.18: `assertTenantServiceable()` is actually wired
    up and ready to enforce those the moment tenant_core defines them, plus
    abuse-prevention limits that are not business quotas — a chat message
    length cap, a two-layer chat rate limit, and a per-request upload-count cap.

---

## 9. Where this is going

### 9.1 Next, in order

0. **Hand the backend contract to Haseeb** (`docs/handoff-to-backend.md`): agree which `/internal/*`
   routes come first — agents and their settings, document availability, phone numbers, customers and
   requests are all stood in here today (§4) — replace the stand-ins as his side lands, and decide who
   sends the customer's confirmation (WhatsApp/SMS).
   Then measuring Urdu end to end. (The conversation-memory fixes seen in testing — a sentence cut by a
   pause, the previous exchange kept across a long pause — and the silences inside the agent's own
   sentences are done, §6.24; a real call on the user's own machine is still to be listened to.)
1. **Finish the once-only embedding pass (§6.20), as soon as a paid key or the
   quota allows ~800 texts** — with an Urdu corpus in it now, since Italian is gone (§6.3 note): `eval:embedding-variants` → adopt a scheme in
   `embed-scheme.js` and bump the version → `reembed` → `db:check` → the two
   sweeps and `MAX_DISTANCE` → `eval:real` before/after, including the
   cross-language category after the language-aware keyword change. Then
   `eval:real -- --update-baseline`. Everything below that touches retrieval is
   judged by that run.
2. **RAG optimisation** — retrieval quality is the product. Open, measured:
   generic overview openers retrieve nothing (the profile now answers them,
   §6.20, but the About chunk is still 0.05–0.09 over the gate: title-in-embedding
   is built-but-off, overview-intent query anchoring is unbuilt); the keyword
   half ANDs every term; the OR query is built, measured keyword-only (3% → 63%
   hit@1) and OFF — adoption checklist in §6.22; follow-up rewrite is ~1–1.5s a turn and needs a faster path
   before voice (§6.19); revisit `MAX_DISTANCE`/chunk sizing once real BUSINESS
   documents (not this project's own fixtures) surface cases they don't.
3. **Vector store scale** — the post-filter starvation is guarded by per-
   transaction iterative scans (§6.1) but with a ceiling (`hnsw.max_scan_tuples`);
   past it, per-tenant partitioning. Also HNSW parameter tuning, index maintenance.

   **What was measured (synthetic 768-dim vectors, scratch table, zero API calls; the harness
   script was REMOVED — see "uncertain" below) and what is trusted:**

   | Measurement | Result | Trust |
   | --- | --- | --- |
   | Server defaults on the app's connection | `iterative_scan` off, `ef_search` 40, `max_scan_tuples` 20,000, `scan_mem_multiplier` 1, `work_mem` 4MB; no database/role overrides; pgvector 0.8.6 | **solid** (now asserted by `db:check`) |
   | Smooth-geometry probe, small tenant owning 20 rows among N packed rows, unguarded | **1 of 20 returned at every N from 2,000 to 40,000** | **solid** (hand-run SQL, repeated) |
   | Same, guarded (`strict_order`) | **20 of 20** at N = 2,000 / 8,000 / 20,000 (the scan visited every row, ≤ the 20,000 cap) | **solid** |
   | Same at N = 40,000 (tenant share 1 in 2,000) | **10 of 20, 20,015 tuples visited** — `max_scan_tuples` IS the ceiling | **solid** |
   | HNSW build, 200k × 768-d | 116–161 s serial, 781 MB; a PARALLEL build fails in Docker (`/dev/shm` is 64 MB — "could not resize shared memory segment") | solid |
   | Planner's own choice with the `tenant_id` btree, tenants of 40 rows / 1% / 10% of the table, at 10k, 50k and 200k chunks | always **tenant btree + exact sort**, never HNSW (small tenant ≈ 0.2 ms; 10% tenant ≈ 75 ms at 200k) | fairly solid, but the scratch table has no JOIN to `knowledge_sources` and the real query may plan differently |
   | Cost of the guard when the HNSW plan IS used and a tenant has fewer than 20 in-gate matches (the scan can never be "satisfied" and runs to its cap) | ≈ 90–105 ms at 200k chunks with the 20,000 cap, ≈ 200 ms at a 100,000 cap, ≈ 500 ms with `scan_mem_multiplier` 8 | plausible, same caveat |
   | **Harness "recall" at 10k / 50k / 200k** (40-chunk, 1% and 10% tenants, clustered, interleaved, 10 / 3 topics, isotropic) | **100% in every configuration, including UNGUARDED** | **NOT trusted — see below** |

   **Uncertain, stated plainly.** The benchmark harness reported 100% recall even with no guard, which
   the hand-run SQL contradicts (unguarded returns 1 of 20). The last inspection showed the harness's
   *exact* reference returning 1 row where the guarded scan returned 20 — so its recall scoring is
   suspect — but that was not resolved and I cannot explain the mismatch in one sentence. **Open
   question; every harness recall figure is unverified**, so there is no measured "recall at 10k /
   50k / 200k" to report. (Also found along the way: rounding vectors to 4 decimals creates exact
   duplicates on a tight curve, and a 1-D cosine curve ties below float32 resolution — both are
   harness traps, not product behaviour.) The harness was removed rather than left to mislead.

   **Decision rule (what the solid evidence supports):**
   - The guard recovers ALL of a tenant's in-gate rows only while the rows of EVERY tenant that sit
     closer to the query than that tenant's farthest wanted row number **≲ 20,000**. For a tenant with
     ≥ 20 matches it needs ≈ 20 ÷ (its share of that neighbourhood) tuples, so the floor is a share of
     **0.1%** of the neighbourhood. Neighbourhood size ≈ tenants × their chunks on the shared topic
     (200 tenants × 100 chunks on the "pricing" topic ≈ 20,000).
   - **Start per-tenant partial indexes / partitioning when a query's neighbourhood approaches ~20,000
     rows AND the planner sends that tenant down the HNSW plan.** Today the planner sends tenants up to
     10% of the table down the exact btree path (measured to 200k chunks), so the practical trigger is
     not the HNSW ceiling but the planner's choice: re-check it with `EXPLAIN` on the real query.
   - **Total-chunk / tenant-count number: unmeasured beyond 200,000 chunks and 203 tenants** (and
     those runs' recall is the unverified part). Do not read "200k" as a safe limit; it is the largest
     size tried. Raising `hnsw.max_scan_tuples` trades latency for recall (≈ 5 µs per tuple at 768-d);
     it moves the ceiling, it does not remove it.
   - `npm run db:check` now fails loudly if the guard is not in effect on the app's connection: the
     `set_config` call is still in `retrieve.js`, `iterative_scan` reads `strict_order` after the
     app's own statement, `max_scan_tuples` ≥ 20,000, `ef_search` ≥ 40, and a live temp-table probe
     (20 rows among 8,000) recovers ≥ 18 rows guarded vs ~1 unguarded.
4. **Multi-file handling at scale** — per-tenant limits, larger batches,
   deduplication, resumable imports.
5. **Tool execution** (§6.11) — then flip `TOOL_EXECUTION_AVAILABLE`.
6. **Voice latency** — DIAGNOSED (§6.24): free-tier Gemini queueing, 3.5–10 s to first token,
   not thinking and not prompt size. Next: add `GROQ_API_KEY`, set `LLM_PROVIDER=groq`
   (`LLM_FALLBACK_PROVIDER=gemini`), run `voice:smoke -- --call` and record the numbers; check
   Groq's answer quality in Urdu; then the follow-up rewrite on voice (§6.19) and
   whether the fast voice tier should be the default for latency-sensitive businesses.
7. **Urdu with real callers** — the voice and the reply are verified; Urdu speech RECOGNITION
   (Groq Whisper) has not been tried with real Pakistani speech, code-switched Urdu/English
   included. Record a handful of real calls before promising it.
8. **Telephony** — §6.30. The lookup (§6.29), the webhook and the phone transport are built; next is the FIRST REAL CALL:
   set the four variables, point a number at the webhook, call it, and tune the VAD / barge-in / latency on real audio.

### 9.2 Twilio — built (§6.30), waiting for its first real call

**The product vision:** a business buys a phone number **from our platform** and
puts an AI agent on it. Twilio handles number provisioning, telephony and
billing underneath; the business never deals with Twilio directly.

The engine's half is built and described in §6.30; what follows is the original plan, kept for the parts that are
still the backend's (provisioning, billing, compliance).

What it needs:

- **Number provisioning** through Twilio's API, surfaced as our own purchase
  flow. The partner handles payment; we handle the Twilio side and the mapping.
- **`phone_number → tenant + agent` routing — BUILT (§6.29).** An inbound call identifies its
  business and agent by **the number that was dialled**: `registry.js resolveDialledNumber()`.
  The webhook verifies Twilio's signature before calling it — never taking the tenant from anything the
  caller supplies — and answers a refusal with `voiceLine("not_in_service")` (BUILT, §6.30).
- **Realtime voice — DECIDED (§6.24): an STT → `respond()` → TTS pipeline**, not
  speech-to-speech. A speech-to-speech model (e.g. Gemini Live) brings its own prompt and
  session and turns retrieval into a tool call — a second brain beside `respond()`, which §1
  forbids. Measured, the speech stages are not the latency problem (STT and first TTS ≈ 0.2–0.5 s
  each, locally); the LLM's first token is. **Budget under ~800 ms to first audio** still stands.
- **Barge-in and turn detection — BUILT** (§6.24): Silero VAD end-of-turn, 350 ms barge-in,
  playback cleared, interrupted turns logged.
- **What Twilio adds on top of the gateway — BUILT (§6.30):** a `transports/twilio.js` beside
  `transports/browser.js` (Media Streams JSON, μ-law 8 kHz ⇄ PCM 16 kHz at the edge — the speech
  benchmark already showed no accuracy loss on simulated 8 kHz audio; `clear` for barge-in;
  `mark` events for playback), a webhook route that verifies the signature and maps the dialled
  number to the tenant in `registry.js`, and `CallRecorder.open({ transport: "twilio",
  fromNumber, toNumber })` — the columns already exist. `CallSession` does not change.
- **Speech engines may move to their own servers** (a VPS or cloud instance near the callers):
  `speech/stt.js` and `speech/tts.js` are the seams — a remote implementation behind the same
  interface, chosen by `VOICE_STT_PROVIDER` / `VOICE_TTS_PROVIDER`.
- **`CHANNEL_STYLE.voice` in `prompt.js` already exists** and forbids markdown,
  lists, emoji and URLs, because every token is read aloud. It was written for
  this and should not be softened.
- **`call_logs` / `call_turns` / `call_events` exist and are written** (§6.24); the recording URL
  column is still unused — audio storage is not yet chosen.
- **Compliance is not optional:** recording disclosure, consent, DNC lists,
  permitted calling hours. The UK and Ireland require telling callers they are speaking to an
  AI and that a call may be recorded; Pakistan has its own rules. Built: the per-agent greeting
  whose built-in text says both (§6.24), and console warnings when an owner's own text drops them —
  the owner decides. Not built: consent capture, DNC lists, calling-hours rules. Budget time.

**To agree with the partner before telephony starts:** who provisions numbers,
how the purchase flow is billed, and the usage-event shape for per-minute
billing. Agree the event shape **early** — retrofitting metering is painful.

---

## 10. Local setup

```bash
npm install
cp .env.example .env     # then fill in DATABASE_URL (as shipped works with the compose file) and GEMINI_API_KEY
npm run db:up            # Postgres 16 + pgvector (docker compose up -d)
npm run prisma:migrate   # apply migrations (read any generated one — §6.1)
npm run dev              # http://localhost:3000 → the test console
npm run voice:models     # once: download the local speech models (~1.3 GB, resumable) — §6.24
npm run voice            # the voice gateway, :3001 — needed for the console's Call button AND phone calls (a SECOND terminal)
npm run build            # runs i18n:check first
npm run start            # serve the production build
npm run lint
npm run db:down          # stop Postgres

# ── checks ──
npm run db:check         # HNSW index, pgvector version + iterative scans, language columns, embedding scheme (§6.1–§6.3)
npm run i18n:check       # translation key + placeholder parity
npm test                 # 732 unit tests: the Twilio phone path (signature, tokens, TwiML, the webhook's decisions, the transfer chain, the transport's wire format, μ-law and resampling), the business summary (no prices, form, the prompt), restaurant orders (reading dishes against the menu, merging changes, pickup/delivery, conditional fields, the whole conversation), ending a call by itself (the words, the decision, the settings, the session), the forwarding line (built-in, owner's, next person), pauses (split-sentence merge, hold-on, still-here), smooth speech (silence trim, pause per join, cut points, gap logging), generic openers (the word files, en/ur/Roman Urdu, what the brain does with one), the call greeting (built-in, owner's, warnings), phone numbers (E.164, routing, cache, signed line), knowledge per agent (rule, input, SQL shape, per-turn scoping), handoff (settings, phrases, decision, per-turn plan), marker,  collect (validate, config, phrases, the whole engine), chunk, tables, query + retrieveForTurn flow, breaker, keyword-query, prompt, crawl, i18n, jobs, extract, rankCandidates, OpenAI-compatible providers (local stand-in), voice (session flow, chunking, voices, STT routing, intent, tickets, PCM, wire format). No DB, no Gemini, no speech models (§11)
npm run voice:smoke      # speech models only: TTS → STT round trip, 16 kHz and simulated phone audio, VAD. ZERO quota (§6.24)
npm run voice:gaps       # silence at every join inside a spoken reply, real voices, before vs now. ZERO quota (§6.24); -- --voice=ID --slow=N
#   -- --call [--tenant=ID] [--say="…"] [--lang=en|ur]   a REAL call through dev + voice with a synthetic caller — spends 1 chat + 1 embedding
npm run twilio:smoke     # a fake Twilio calls the REAL app + gateway (needs both running, TWILIO_* set): signature refusals, an answered call, μ-law audio both ways, the call record — spends a chat request only with a model key (§6.30)
npm run test:numbers     # the phone-number lookup against the real DB: every refusal, re-linking, release, isolation — no quota (§6.29)
npm run test:agents      # several agents per tenant + knowledge per agent + every setting per agent (greeting and recording switch included), against the real DB, faked models — spends no quota (§6.27, §6.28)
npm run test:collect     # request-taking end to end against the real DB (configure → converse → read-back → save → idempotent retry → status workflow → tenant isolation), faked models — spends no quota (§6.25)
npm run test:reembed     # ingest/re-embed invariants against the real DB with a FAKED embedder — spends no quota (§6.10)
npm run test:openrouter  # OpenRouter integration vs. a local stand-in

# ── retrieval evals (each query spends embedding quota — §8 limitation 3) ──
npm run eval:retrieval   # fast fixture-only smoke check — NOT the hybrid pipeline (§6.3)
npm run eval:sweep       # threshold boundary for that same small fixture
npm run eval:real        # THE gate — real hybrid pipeline, full test-docs corpus, baseline diff (§6.3)
npm run audit:chunks     # chunk stats per document (no-heading / runt / oversize); -- --structured, -- --compare, -- --out=FILE. No quota (§6.23)
npm run eval:trigger     # does the cheap trigger spend a rewrite on standalone questions? precision/recall vs the labelled set. No quota (§6.19)
npm run eval:keyword     # keyword half ALONE over the stored eval chunks: AND vs OR vs OR+norm, per category/language. No quota (§6.22)
npm run eval:real:sweep  # per-category threshold boundary on the same labelled set
#   eval:real flags (node scripts/eval-retrieval-real.mjs …):
#     --skip-ingest            reuse the corpus already in the eval tenant (saves ~55 embedding calls)
#     --strategy=raw|concat    follow-up query strategy to MEASURE (§6.19); exploratory, never touches the baseline
#     --keyword=or             run the CANDIDATE OR keyword query, judged read-only against the baseline (§6.22)
#     --update-baseline        accept this run's numbers (prints what got worse first)
npm run eval:embedding-variants   # pick an embedding scheme in memory, before re-embedding anything (§6.2); -- --dry-run counts the texts it needs

# ── maintenance ──
npm run reembed:dry      # how many embedding texts a re-embed would spend; embeds nothing
npm run reembed          # re-embed every document below the current scheme; RESUMABLE (exit 3 = daily quota stop, run again later)
#   reembed flags: --tenant=ID  --max-texts=N (stop cleanly after ~N chunks)  --pace-ms=700
npm run db:backfill-search  # label existing chunks with their document's language (§6.3); -- --dry-run first. No embeddings.
node scripts/repro-tenant-recall.mjs [--interleaved] [--tenants=60]   # synthetic multi-tenant recall probe on a scratch table (§6.1)
```

**Windows gotcha:** `prisma generate` fails with `EPERM … rename … query_engine` while
`next dev` is running (it holds the engine DLL), and a stopped-and-restarted dev server
keeps the OLD client in memory. After any schema change: apply the migration, stop the
dev server **and the voice gateway** (it loads the same engine DLL), `npx prisma generate`,
start both again.

**Database is `caller-ai-agent`.** An older `nyron` database may exist on the same
Postgres as an untouched backup — if you see it in a connection string, it is
stale.

`.env` (see `.env.example`, which documents every variable below):
- `DATABASE_URL` (must include `?schema=ai_engine`), `GEMINI_API_KEY` — required.
- `GEMINI_CHAT_MODEL` — each model has its **own** free daily quota, so switching
  model is the normal way to keep working. Verified free and working:
  `gemini-3.5-flash-lite` (~1s), `gemini-flash-lite-latest`, `gemini-3.1-flash-lite`.
- `INTERNAL_API_KEY` — guards every route (header `x-internal-key`). **Fails closed
  in production**; allowed with a warning in dev, which is what lets the test console
  work.
- `LLM_PROVIDER` / `LLM_FALLBACK_PROVIDER` (`gemini` | `groq` | `openrouter`),
  `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL` (any OpenAI-compatible
  endpoint — Ollama — with no code change), `PUBLIC_APP_URL` (sent to OpenRouter as the referer
  header).
- **Groq** (§6.24): `GROQ_API_KEY` — one free key for the fast chat model AND Urdu speech
  recognition; `GROQ_MODEL` (default `openai/gpt-oss-120b`), `GROQ_REASONING_EFFORT` (`low` for
  gpt-oss), `GROQ_REWRITE_MODEL`, `GROQ_STT_MODEL` (default `whisper-large-v3`).
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` —
  optional, **all three or none**: `storage.js` treats them as configured when all
  are non-empty, so a placeholder value counts as configured. Uploads work without
  them; `storage.js` just skips storing the original file (§6.13) and logs a warning
  instead of failing the import.
- Phone calls (§6.30, optional): `TWILIO_AUTH_TOKEN` (verifies every webhook, places transfers), `TWILIO_ACCOUNT_SID`
  (transfers), `TWILIO_WEBHOOK_BASE_URL` (the public https origin of this app; falls back to `PUBLIC_APP_URL`) and
  `VOICE_GATEWAY_PUBLIC_URL` (required for phone calls: Twilio opens the stream at `wss://…/twilio`).
- Voice (§6.24, all optional): `VOICE_GATEWAY_PORT` (3001), `VOICE_GATEWAY_PUBLIC_URL` (when the
  browser reaches the gateway somewhere other than this host on that port), `VOICE_SESSION_SECRET`
  (signs session tickets — both processes must share it; falls back to `INTERNAL_API_KEY`),
  `VOICE_MODELS_DIR`, `VOICE_STT_THREADS` (2) / `VOICE_TTS_THREADS` (every logical core),
  `VOICE_STT_PROVIDER` (`auto` | `local` | `groq`), `VOICE_TTS_PROVIDER` (only `local`).
- Script-only knobs (not read by the app): `APP_URL` (where the eval and OpenRouter
  scripts find the running app, default `http://localhost:3000`), `EVAL_TENANT`,
  `TEST_TENANT`, `FAKE_PORT`, `EMBED_VARIANTS_CACHE`.

`.env*` is gitignored **except `.env.example`**, which is committed and lists every variable the code reads (it
used to be swallowed by that same ignore rule, so every "cp .env.example .env" pointed at a missing file). Never
commit keys; update `.env.example` in the same commit as any new, renamed or removed variable (§11).

---

## 11. Working conventions

- **Tests: `npm test`** — node:test, no dependency, imports `src/` through the same
  `scripts/alias-loader.mjs` the maintenance scripts use. Every file imports
  `tests/helpers/no-db.mjs` first, which plants a trap on `globalThis.prisma` (db.js
  reuses it), so a "pure" test that reaches the database fails loudly; `jobs.test.mjs`
  plants an in-memory fake instead. Tests never call Gemini. A bug found by a test gets
  its own named test; a fix that changes what is embedded stays behind `embed-scheme.js`.

- **★ HANDOVER DOCUMENTS STAY CURRENT — a stale line is a bug, fixed in the same commit.** These are read by
  people and AI agents who were not here — the partner (Abdul Haseeb), his assistants, the next session — and they
  act on them. A wrong line in them is worse than a missing one: someone builds the wrong thing from it.

  | Document | Who reads it | Update it when… |
  | --- | --- | --- |
  | `CLAUDE.md` | every session, first | any rule, decision, ownership, file, command, migration or measured number changes |
  | `docs/handoff-to-backend.md` | the partner and his AI | an API, a field, an event, a stand-in, or who owns what changes |
  | `README.md` | anyone opening the repo | setup, commands or what the product does changes |
  | `src/lib/standins/README.md` | whoever replaces the stand-ins | a stand-in is added, removed or changes shape |
  | `.env.example` | whoever deploys | an environment variable is added, renamed or removed |

  **Before every commit:** (1) grep these files for every route, table, function and number the change touched;
  (2) fix test counts (`npm test` prints them) and migration names; (3) when a decision changes, rewrite the old
  sentence — do not add a contradicting one below it; (4) say in the commit message which documents were updated.
  Measurements taken before a change stay, labelled with when they were taken; a CURRENT-state claim never does.

- **JavaScript, not TypeScript.** JSDoc on exported functions, as `lib/agent/*` does.
- **Comments explain *why*, not *what*.** The existing files set the bar. Every
  non-obvious constraint in §6 has a comment at the code that depends on it, so
  the next session cannot undo it by accident.
- **Don't add dependencies casually.** The stack is deliberately small.
- **Gemini model names get retired.** A 404 names its replacement — put it in
  `GEMINI_CHAT_MODEL`.
- **`AGENTS.md` is auto-generated** by `next dev`. Don't fight it; commit it.
- The default branch is `main`. Work on a feature branch and open a PR against it.
