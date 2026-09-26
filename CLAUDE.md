@AGENTS.md

# Caller AI Agent — project guide

> **Read this file first, in full, before writing any code.** It is the handover
> document: what we are building, what we deliberately are not, which decisions
> are already settled and must not be re-litigated, and where the traps are.
>
> If this file and the code disagree, **the code wins** — and fix this file in
> the same change.

---

## 1. What this is

**An AI phone agent for small businesses.** A business trains an agent on its
own material — price list, opening hours, policies — and that agent then answers
their customers **on the telephone**.

The product is a **calling system**. Everything else exists to serve that.

| | |
| --- | --- |
| **The channel we are building** | Voice, over real phone numbers (Twilio — §9) |
| **What exists today** | The RAG engine underneath it, plus a test chat to exercise it |
| **What was removed** | An embeddable website chat widget. Deliberately, permanently. See §2. |

### The one-brain rule

Every channel is a **thin adapter over one shared brain**
([`respond.js`](src/lib/agent/respond.js)). A business configures its agent
once — name, purpose, tone, hours, what it may do, what it knows — and that
configuration applies identically on every channel.

An adapter's only job is: parse the transport, ensure a `Conversation` row
exists, call `respond()`, translate the reply back into that transport.
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
| **Chat model** | Pluggable: `LLM_PROVIDER` = `gemini` \| `openrouter` | Via [`llm.js`](src/lib/agent/llm.js). |
| **Embeddings** | **Gemini only — not swappable** | `gemini-embedding-001` @ 768 dims. §6.2 explains why this is a correctness constraint. |
| Documents | `pdfjs-dist`, `mammoth`, `tesseract.js`, `@napi-rs/canvas` | All four in `serverExternalPackages`; see §6.8. |

---

## 4. Who owns what

- **Us — the AI engine.** RAG, the brain, channel adapters, telephony plumbing,
  tool-calling, conversation storage, i18n of everything we render.
- **Partner — the multi-tenant platform.** Tenants, users, auth, roles,
  billing/plans, the business-facing dashboard, onboarding, quotas.

We **never** create or migrate tenant tables. We consume `tenantId` as an opaque
string and scope every query by it.

**DECIDED — agent configuration lives on our side.** `agent_configs` is in
`ai_engine`; the partner's dashboard edits it through `PUT /api/agent-config`.
Persona and capabilities change whenever the prompt pipeline changes, so keeping
them here means prompt iteration never waits on his migrations.

**★ Two seams exist so his half can arrive without a refactor:**

| Seam | Question it answers | Change it when |
| --- | --- | --- |
| [`tenant/config.js`](src/lib/tenant/config.js) | What has this business configured? | We need a field that lives in `tenant_core` |
| [`tenant/registry.js`](src/lib/tenant/registry.js) | May this tenant be served? | Billing/suspension/quota exists — edit `assertTenantServiceable()` and **nothing else** |

Never let tenant-state checks leak into route handlers. The day one is missed is
the day a suspended tenant keeps being served.

---

## 5. Repo layout

```
prisma/schema.prisma           # ai_engine only — read its header
scripts/
  check-locales.mjs            # translation parity; runs on `npm run build`
  check-db.mjs                 # guards the HNSW index Prisma keeps dropping (§6.1)
  eval-retrieval.mjs           # retrieval quality gate + threshold sweep (§6.3)
  test-openrouter.mjs          # OpenRouter integration vs. a local stand-in
src/app/
  page.js                      # THE TEST CONSOLE — config, knowledge, chat
  api/
    chat/route.js              # internal test chat (SSE) — NOT a product channel
    agent-config/route.js      # GET/PUT — partner's dashboard contract
    agent-config/catalog/      # capability list, translated, for his UI
    knowledge/route.js         # list + add/replace: typed text, uploads, URL crawl
    knowledge/[id]/route.js    # read, edit, rename, delete one document
    knowledge/jobs/route.js    # background import progress (§6.6)
    knowledge/search/route.js  # retrieval debug + eval harness
    locales/route.js           # whole UI in one language, for his dashboard
    ingest/route.js            # legacy single-document ingest
src/lib/
  agent/
    llm.js                     # ★ LLM SEAM — chat swappable, embeddings are not
    gemini.js / openrouter.js  # providers; import ONLY from llm.js
    retry.js                   # shared backoff; quota vs. rate-limit
    respond.js                 # ★ THE BRAIN — channel-agnostic
    prompt.js                  # ALL prompt text
    retrieve.js                # cosine kNN + relevance threshold (§6.3)
    chunk.js                   # heading-aware splitter (§6.4)
    extract.js                 # pdf/docx/txt/md/csv → text; editability rule (§6.7)
    ocr.js                     # scanned-PDF OCR (§6.5)
    crawl.js                   # website crawling + SSRF defences (§6.9)
    ingest.js                  # create/REPLACE/rename/delete documents (§6.10)
    jobs.js                    # background import queue (§6.6)
    capabilities/catalog.js    # what the agent can DO, per channel
  tenant/ config.js, registry.js   # ★ the two seams
  i18n/   index.js, catalogs.js    # en + it active; ar + ur dormant
  security/rate-limit.js       # generic limiter — telephony webhooks will need it
  db.js                        # PrismaClient singleton
src/locales/en|it/             # ACTIVE: common, dashboard, capabilities, validation, errors
src/locales/ar|ur/             # DORMANT — translated, on disk, not build-enforced
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
`npm run db:check` catches it if you do.

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

### 6.4 Chunking is heading-aware

[`chunk.js`](src/lib/agent/chunk.js) splits at headings, then paragraphs, then
sentences. Fixed-size windows cut price tables in half and split policies
mid-sentence, producing chunks that each read as a different rule.

**The heading path is prepended to `embedText` but NOT to `content`.** Under a
heading "Whitening" the body often says "250 euros" and never repeats the word —
embedded alone, that chunk cannot match "how much is whitening?". The heading
puts the words back for the vector while the quoted text stays clean.

### 6.5 OCR, and the detached-buffer trap

[`ocr.js`](src/lib/agent/ocr.js) renders each page with pdfjs and reads it with
Tesseract (`eng+ita`). Triggered by `looksScanned()`, which tests characters
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

Embedding a large PDF is one model round trip per chunk; OCR is seconds per
**page**. Neither belongs in an HTTP request. Uploads return **202 with job ids**
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
- **Typed text stays synchronous.** It is fast, and someone who just clicked Save
  expects the document to be there.

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
- Size-capped, time-capped, bounded page count, HTML/text only.
- **Same-origin links only.** A business asked us to read THEIR site.

Verified refused: cloud metadata, `127.0.0.1`, `localhost`, `10.x`, `192.168.x`,
IPv6 loopback, `file://`.

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

**Known limitation:** replace fixes duplicates *within* a document. Two different
documents that disagree is a separate problem — retrieval passes each source's
last-updated date and the prompt has a conflict rule, so the agent surfaces the
discrepancy rather than silently picking. Observed and fixed after a corrected
price lost to a stale one in another file.

### 6.11 The model never silently mutates tenant data

`TOOL_EXECUTION_AVAILABLE` in `prompt.js` is **`false`**. Capabilities flagged
`requiresTool` are described to the model *plus* a hard guard: gather details,
promise follow-up, never claim completion, never invent a reference number.

A model told "you can book appointments" with no tool behind it will confidently
reply "you're booked for Tuesday at 3" — a plausible lie to a real customer.
Flip the flag only **after** tools genuinely execute, and log every executed call
to `agent_actions`.

### 6.12 API routes always return JSON

Wrap handlers in try/catch and return `NextResponse.json({ error }, { status })`.
An uncaught throw sends an empty body and the client sees "Unexpected end of
JSON input" instead of the real cause.

---

## 7. Languages

Active: **English (default) and Italian**. Nothing user-facing is a hardcoded
string — not a heading, not a button, not a validation message.

**⚠️ TWO SETTINGS. They answer different questions — never merge them.**

| Setting | Values | Controls |
| --- | --- | --- |
| `agent_configs.uiLocale` | `en` \| `it` | The **interface** — every dashboard screen |
| `agent_configs.replyLanguage` | `en` \| `it` \| `auto` | What the **agent says**; `auto` mirrors whoever is speaking |

A clinic can run an Italian dashboard while its agent mirrors each caller.

- **`auto` IS NOT A LOCALE.** There is no `auto` catalog; it never reaches `t()`.
  It becomes an instruction in `prompt.js`. `isReplyLanguage()` keeps them apart.
- **`buildSystemInstruction()` takes no `locale` parameter** — reply language
  comes from `config.replyLanguage`; interface language is presentation and must
  never leak into a prompt.
- **Precedence differs by design**: for UI a saved `uiLocale` outranks
  `Accept-Language` (the owner decided); for replies the speaker's own language
  wins. Both have been got backwards once — don't reintroduce either.
- `ar` and `ur` are **dormant**: fully translated, on disk, excluded from
  `SUPPORTED_LOCALES`, `catalogs.js` and `ACTIVE_LOCALES`. Not build-enforced, so
  expect drift. RTL helpers are kept because every layout uses logical CSS, so
  reactivating Arabic is config rather than redesign.
- `npm run i18n:check` enforces key **and** placeholder parity and runs on build.
  Translation rot is silent; do not weaken this to unblock a build.
- Plurals go through `Intl.PluralRules`. Arabic has **six** categories, so
  `count === 1 ? a : b` gets nearly every Arabic sentence wrong.

---

## 8. What works today

**End to end, verified against a live database:** give the agent documents →
ask it a question → get a grounded, correctly-sourced answer, streamed, in the
right language, with history persisted per tenant.

| Area | State |
| --- | --- |
| RAG retrieval | ✅ 100% hit@1, MRR 1.000, 100% off-topic rejection (`npm run eval:retrieval`) |
| Heading-aware chunking | ✅ verified on tables and multi-section documents |
| Relevance threshold | ✅ measured at 0.43; off-topic questions return nothing |
| Multi-file upload | ✅ one job per file; bad files rejected individually |
| PDF / DOCX / TXT / MD / CSV | ✅ extracted; Word heading levels survive into chunk headings |
| **OCR for scanned PDFs** | ✅ character-perfect on an image-only PDF |
| Background jobs + live progress | ✅ real percentages, stage labels, stale-job reaping |
| Website crawling | ✅ with SSRF defences verified against 8 attack vectors |
| Replace / edit / rename / delete | ✅ enforced server-side |
| Conflict surfacing | ✅ agent names the discrepancy rather than guessing |
| Interface + reply languages | ✅ independent, both directions |
| Test chat (SSE streaming) | ✅ `/api/chat` |

### Limitations — be honest about these

1. **⚠️ NOTHING IS COMMITTED TO VERSION CONTROL.** Many phases of work exist only
   on one disk. This is the single largest risk on the project.
2. **No telephony yet.** The calling system — the actual product — is not built.
   §9 is the plan.
3. **No tool execution.** The agent collects booking details but cannot book.
   Guarded so it never claims otherwise (§6.11).
4. **Free-tier model quotas.** Gemini free tier is ~20 chat requests/day *per
   model*; switching `GEMINI_CHAT_MODEL` moves to a fresh quota. OpenRouter's
   free Gemma pool has never once responded. **A paid key is required before any
   demo**; embeddings are on a separate, working quota.
5. **No automated unit tests.** The retrieval eval and the OpenRouter test are
   the only mechanical checks; everything else was verified by hand.
6. **In-process state** — job queue and caches. Multi-instance needs Redis.
7. **Italian is not native-reviewed.**
8. **No per-tenant limits** on uploads, documents or storage. Planned.
9. `README.md` is still the create-next-app default.

---

## 9. Where this is going

### 9.1 Next, in order

1. **RAG optimisation** — retrieval quality is the product. Re-ranking, better
   chunk sizing, query rewriting, evals on real business documents.
2. **Vector store scale** — HNSW parameter tuning, index maintenance, per-tenant
   partitioning as chunk counts grow.
3. **Multi-file handling at scale** — per-tenant limits, larger batches,
   deduplication, resumable imports.
4. **Tool execution** (§6.11) — then flip `TOOL_EXECUTION_AVAILABLE`.
5. **Telephony** — §9.2.

### 9.2 Twilio — the destination, not yet started

**The product vision:** a business buys a phone number **from our platform** and
puts an AI agent on it. Twilio handles number provisioning, telephony and
billing underneath; the business never deals with Twilio directly.

Not being built yet — RAG and file handling come first — but **every decision
made now should be compatible with it.**

What it will need:

- **Number provisioning** through Twilio's API, surfaced as our own purchase
  flow. The partner handles payment; we handle the Twilio side and the mapping.
- **`phone_number → tenant` routing.** An inbound call identifies its tenant by
  **the number that was dialled**. That lookup belongs in
  [`registry.js`](src/lib/tenant/registry.js), from a **verified Twilio webhook
  signature** — never from anything the caller supplies.
- **Realtime voice.** Decision still open: a speech-to-speech model
  (e.g. Gemini Live) versus an STT → LLM → TTS pipeline. Speech-to-speech is
  likely better — a pipeline stacks three latencies. **Budget under ~800ms to
  first audio**, or a call feels broken.
- **Barge-in and turn detection.** Callers interrupt; an agent that talks over
  them is unusable.
- **`CHANNEL_STYLE.voice` in `prompt.js` already exists** and forbids markdown,
  lists, emoji and URLs, because every token is read aloud. It was written for
  this and should not be softened.
- **`call_logs` already exists** — duration and a recording URL, with audio in
  object storage (not yet chosen).
- **Compliance is not optional:** recording disclosure, consent, DNC lists,
  permitted calling hours. Italy and the Gulf have real constraints. Budget time.

**To agree with the partner before telephony starts:** who provisions numbers,
how the purchase flow is billed, and the usage-event shape for per-minute
billing. Agree the event shape **early** — retrofitting metering is painful.

---

## 10. Local setup

```bash
npm run db:up            # Postgres + pgvector
npm run prisma:migrate   # apply migrations
npm run dev              # http://localhost:3000 → the test console

npm run db:check         # verifies the HNSW index Prisma keeps dropping
npm run i18n:check       # translation key + placeholder parity
npm run eval:retrieval   # retrieval quality gate
npm run eval:sweep       # threshold boundary — read before changing MAX_DISTANCE
npm run test:openrouter  # OpenRouter integration vs. a local stand-in
npm run lint
npm run build            # runs i18n:check first
```

**Database is `caller-ai-agent`.** An older `nyron` database exists on the same
Postgres as an untouched backup — if you see it in a connection string, it is
stale.

`.env` (see `.env.example`):
- `DATABASE_URL` (must include `?schema=ai_engine`), `GEMINI_API_KEY` — required.
- `GEMINI_CHAT_MODEL` — each model has its **own** free daily quota, so switching
  model is the normal way to keep working. Verified free and working:
  `gemini-3.5-flash-lite` (~1s), `gemini-flash-lite-latest`, `gemini-3.1-flash-lite`.
- `INTERNAL_API_KEY` — guards every route. **Fails closed in production**;
  allowed with a warning in dev, which is what lets the test console work.
- `LLM_PROVIDER`, `LLM_FALLBACK_PROVIDER`, `OPENROUTER_*`, `OPENROUTER_BASE_URL`
  (any OpenAI-compatible endpoint — Ollama, Groq — with no code change).

`.env*` is gitignored. Never commit keys; update `.env.example` instead.

---

## 11. Working conventions

- **JavaScript, not TypeScript.** JSDoc on exported functions, as `lib/agent/*` does.
- **Comments explain *why*, not *what*.** The existing files set the bar. Every
  non-obvious constraint in §6 has a comment at the code that depends on it, so
  the next session cannot undo it by accident.
- **Don't add dependencies casually.** The stack is deliberately small.
- **Gemini model names get retired.** A 404 names its replacement — put it in
  `GEMINI_CHAT_MODEL`.
- **`AGENTS.md` is auto-generated** by `next dev`. Don't fight it; commit it.
- Branch is `master`; PRs target `main`.
