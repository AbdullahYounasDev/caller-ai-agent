# caller-ai-agent

An AI phone agent for small businesses — first markets: restaurants and call centres in the UK and Ireland, and
businesses in Pakistan. A business gives its agent its own material (price list, menu, opening hours, policies) and
the agent answers its customers in English or Urdu, takes requests (appointments, call-backs) and passes a caller to
a person when it should.

**This repo is the AI ENGINE.** The multi-tenant platform (accounts, billing, the business dashboard, buying phone
numbers) is the partner's backend; the split, and everything the engine stands in for until that backend exists, is
in [`docs/handoff-to-backend.md`](docs/handoff-to-backend.md).

**Read [CLAUDE.md](CLAUDE.md) before changing anything.** It is the handover document: the settled decisions, the
failures behind each rule, what works and what does not, and the measured numbers.

## What works today

- **One brain, many agents.** A business has one or more agents (a branch, a line, a client); each has its own
  settings, voice, language, checklist and call forwarding. All agents use one knowledge library; each document is
  shared or limited to some agents.
- **Knowledge:** PDF / DOCX / TXT / MD / CSV uploads (scanned PDFs via OCR), typed text, website crawling; hybrid
  vector + keyword search with a measured relevance threshold.
- **Voice calls from the browser** through a separate voice gateway: local speech recognition and synthesis (Groq
  Whisper for Urdu), barge-in, full call logging.
- **Taking requests** (appointments, call-backs) with a deterministic checklist engine — the AI never books on its own.
- **Passing a caller to a person** (call forwarding) and ending calls politely.
- **Call greeting per agent:** the owner's own words, or a built-in greeting that tells callers they are speaking with
  an AI assistant (and that the call is recorded, only when the agent's recording switch is on).
- **Generic openers** ("who are you?", "tell me about your company", "aap kya karte hain?") recognised in English,
  Urdu and Roman Urdu — the word lists are plain files in `src/lib/phrases/`, one per language.
- **Phone numbers:** the lookup "this number was dialled → which business, which agent" is built and tested.
- **Not built yet:** the Twilio webhook and phone transport (real phone calls), and the backend's half (stood in here).

## Stack

Next.js 16 (App Router, JavaScript), React 19, Tailwind v4, Postgres 16 with pgvector, Prisma 6. Gemini for
embeddings (not swappable); chat via Gemini, Groq or OpenRouter. Local speech: Kokoro / Piper (voices), Parakeet +
Silero (recognition, voice activity). Optional Cloudinary for original uploaded files.

## Setup

Needs Node.js 20+, Docker, and a Gemini API key (a Groq key for fast replies and Urdu recognition).

```bash
npm install
cp .env.example .env     # set GEMINI_API_KEY; the default DATABASE_URL matches docker-compose.yml
npm run db:up            # Postgres 16 + pgvector
npm run prisma:migrate   # apply migrations (read any generated one — CLAUDE.md §6.1)
npm run dev              # http://localhost:3000 — the test console
npm run voice:models     # once: download the speech models (~1.3 GB)
npm run voice            # the voice gateway on :3001, in a second terminal (for the Call tab)
```

`INTERNAL_API_KEY` guards every route. Leave it unset locally (the console cannot send the header); it fails closed
in production. Every environment variable is documented in `.env.example`.

After pulling a new migration: stop `npm run dev` **and** `npm run voice`, run `npx prisma migrate deploy` and
`npx prisma generate`, start both again.

The free Gemini tier is small (about 1000 embedding texts a day, counted per text) and is easy to exhaust while
testing; see CLAUDE.md §8.

## Commands

| | |
| --- | --- |
| `npm run dev` / `build` / `start` | run, build (runs `i18n:check` first), serve |
| `npm run voice` | the voice gateway (Call tab) |
| `npm run lint` | ESLint |
| `npm test` | unit tests — no database, no model, no quota |
| `npm run test:collect` | request-taking end to end on the real database, models faked |
| `npm run test:agents` | agents, knowledge per agent and every per-agent setting, on the real database |
| `npm run test:numbers` | the phone-number lookup on the real database |
| `npm run test:reembed` | ingest and re-embed invariants with a faked embedder |
| `npm run db:up` / `db:down` | start / stop Postgres |
| `npm run prisma:migrate` | apply migrations — read any generated one; Prisma wants to drop the HNSW index |
| `npm run db:check` | verify the HNSW index, pgvector features, language columns, embedding scheme |
| `npm run i18n:check` | English / Urdu translation key and placeholder parity |
| `npm run voice:smoke` | speech benchmark (no quota); `-- --call` places a real call with a synthetic caller |
| `npm run eval:real` | the retrieval gate: real pipeline, `test-docs/` corpus, compared with a saved baseline |
| `npm run reembed:dry` / `reembed` | count / run a resumable re-embed of existing documents |

The evals and `reembed` spend embedding quota; the full list, flags and the recommended order are in CLAUDE.md §10.

## Layout

- `src/lib/agent/` — the engine: `respond.js` (the brain), retrieval, prompts, ingestion, the model seam.
- `src/lib/voice/` — the voice gateway and the call session.
- `src/lib/collect/`, `src/lib/handoff/`, `src/lib/telephony/` — taking requests, passing to a person, phone routing.
- `src/lib/tenant/` — the seams to the backend (agents and settings, serviceability, the phone-number lookup).
- `src/lib/standins/` — what the backend will replace.
- `src/app/page.js` — the test console; `src/app/api/` — the routes.
- `scripts/` — tests against the database, evals, maintenance. `test-docs/` — the eval corpus.

Full layout: CLAUDE.md §5.
