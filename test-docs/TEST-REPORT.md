# caller-ai-agent — Black-box Test Sweep Report

**Target:** live dev instance at `http://localhost:3000` ("Nyron Software Solutions" fictional test knowledge base)
**Method:** pure HTTP black-box testing via a shared Node CLI, one isolated tenant per tester
**Testers:** Ali (`test-ali`), Adan (`test-adan`), Asad (`test-asad`), Haseeb (`test-haseeb`), Abdullah (`test-abdullah`, `test-abdullah-replace-check`)
**Date:** 2026-09-29

---

## 1. Executive summary

**Scenarios tested across all five testers: 30+**, spanning baseline grounding, hallucination guards, off-topic rejection, cross-document conflict handling, PDF/DOCX/MD/CSV/scanned-PDF ingestion, chunking edge cases (heading misdetection, runt merging, run-on-sentence hard-split), job cancellation, sequential processing, the replace mechanic, knowledge editability rules, language independence (`uiLocale` vs `replyLanguage`), human-readable error surfacing, and mixed-outcome multi-file uploads.

**4 confirmed bugs**, ranked by real-world impact on a live phone-call product:

| # | Bug | Impact |
|---|---|---|
| 1 | Cross-document conflict-surfacing silently defeated by retrieval crowding (Haseeb) | **Critical.** Agent gives a confident, wrong price on a live call with no indication a conflict exists — exactly the failure mode §6.2/§6.10 are designed to prevent. |
| 2 | PDF chunking loses headings entirely and skips the long-run-on-sentence hard-split, producing a heading-less mega-chunk with a fabricated-sounding extraction artifact that reached a real chat answer (Adan) | **High.** Produces plausible-but-wrong instructions to a real caller, specific to PDF documents. |
| 3 | `PUT /api/knowledge/:id` returns HTTP 200 instead of documented 409 for non-editable formats, silently no-op'ing the edit (Ali) | **Medium.** No data corruption, but breaks the API contract — a caller (e.g. the partner's dashboard) cannot distinguish "saved" from "silently rejected." |
| 4 | Job-cancellation endpoint returns a confident "cancelled" response for a job that finishes normally moments later and overwrites that status to "done" (Asad) | **Medium.** Misleading API contract only — data integrity confirmed intact, no duplicate/orphan rows. |

Everything else tested — baseline grounding, the hallucination guard, off-topic rejection, the heading-misdetection guard, runt-paragraph merging, OCR, sequential job processing, the replace mechanic, threshold separation, and (in this tester's own cluster) language independence and human-readable error handling — **held up correctly**. One test-fixture bug (filename mismatch blocking the replace test) was found and fixed mid-sweep, not a product bug.

---

## 2. Bugs found

### 2.1 Cross-document conflict-surfacing silently defeated by retrieval crowding — CRITICAL (found by Haseeb)

**What's broken:** §6.10 documents that when two sources disagree, "retrieval passes each source's last-updated date and the prompt has a conflict rule, so the agent surfaces the discrepancy rather than silently picking." In practice, whether the model ever *sees* the conflicting chunk depends on retrieval ranking — and one document's sheer chunk density can crowd the other's single conflicting chunk out of the context window entirely, before the conflict rule ever gets a chance to fire.

**Evidence (verbatim from Haseeb's report):**

Uploaded `03-storepulse-pricing-plans.docx` (Pro = 149 euro), waited, then uploaded `08-storepulse-price-list-conflict.txt` (Pro = 179 euro, confirmed as a separate `sourceId`), waited.

> `chat "How much is StorePulse Pro?"` →
> `{"reply":"Our Pro plan is priced at 149 euros per month and supports up to 5 stores. Every plan includes a 14-day free trial with no credit card required to start.","sources":["03-storepulse-pricing-plans.docx"]}`

No conflict was flagged. The agent silently picked 149 and never mentioned 179 or the second document.

Root cause via search: `search "StorePulse Pro plan price"` at `topK 6` (what chat effectively sees) returned all 6 results from `03-storepulse-pricing-plans.docx`, **zero** from the `.txt` conflict doc. At `topK 20` (pure-vector debug, no threshold cutoff), the conflict doc's "Pro Plan" chunk (179 euro) **does exist and is threshold-admitted** — distance 0.274, `kept:true`, well under `MAX_DISTANCE=0.43` — but ranks 11th, because the `.docx` alone fills ranks 1–10 with near-duplicate chunks about its own Pro plan (distances 0.117–0.243). The conflicting fact never reaches the model as context.

**Why it matters:** This is exactly the "confident nonsense" failure mode §6.2 warns about — not from an embedding-model mismatch, but from retrieval crowding. On a live phone call, a customer asking about pricing gets a confident, wrong answer with zero signal that a second, contradicting document exists. Haseeb's theory (not confirmed, black-box only, did not read source): the conflicting chunk sits under a heading ("Pro Plan") textually identical to the dominant document's own heading, so heading-keyed diversification may not be balancing the two *documents* against each other, only headings within the pool it's given.

---

### 2.2 PDF chunking loses headings and skips the run-on-sentence hard-split, leaking a fabricated-sounding artifact into a real answer — HIGH (found by Adan)

**What's broken:** §6.4 documents a hard-split fallback for any single sentence (or run of text with no terminal punctuation) longer than `TARGET_CHARS`. For the PDF tested, this did not happen — a ~1,400-character run-on sentence sailed through as part of one oversized, heading-less chunk.

**Evidence (verbatim from Adan's report):**

`07-storepulse-user-guide.pdf` (4,350 bytes, 7 sections + intro, one section — "4. Onboarding Walkthrough" — confirmed via direct read to be a single ~1,400-char sentence with no internal period) produced **`chunkCount: 2`** total, versus 7 chunks for a smaller `.txt` and 5 for a smaller `.md` from the same batch.

Five targeted queries hitting the start/middle/end of the long sentence all surfaced the same two chunks, both `heading: null`:
```
{"sourceTitle":"07-storepulse-user-guide.pdf","heading":null,"preview":"account setup to running the first end of day reconciliation.\n1. branch chains. dashboard.\n2. Create a store profile with its address, opening hours and time zo"}
{"sourceTitle":"07-storepulse-user-guide.pdf","heading":null,"preview":"6. End of Day Reconciliation\nAt the close of business, the till staff run the end of day report, which compares recorded sales\nagainst the cash and card totals "}
```
No chunk's preview ever contained "onboarding specialist" (the literal start of section 4) even at `topK 20`. Chunk A = intro + sections 1–5 merged into one ~2,400+ char chunk; chunk B = sections 6–7 (~370 chars). Both `heading: null` — the PDF's numbered headings were never detected at all.

**Secondary symptom — the artifact reaching a real answer:**

> `chat "Walk me through the StorePulse onboarding process"` →
> *"To get started with StorePulse, we first **set up your branch chains** and create store profiles with your address, opening hours, and time zone. Next, you can easily import your product catalogs using a CSV export from your previous point of sale system. Finally, you configure low stock thresholds for each product category..."*

This never mentions actual section-4 content and paraphrases sections 2/3/5 as "the onboarding process." The phrase "set up your branch chains" is a garbled PDF-extraction artifact from the source's hyphenated line-wrap ("...small multi-\nbranch chains. It combines point of sale integration...") — it leaked into the chunk as a fluent but fabricated-sounding instruction.

**Why it matters:** On a live phone call, this is the agent inventing a plausible-sounding but nonsensical step and presenting it as fact — indistinguishable to the caller from a real answer. Adan's theory (not confirmed, did not read source): PDF text extraction may not preserve the blank-line-after-heading signal `detectHeading()` requires, so numbered PDF headings are never recognized as headings at all, which in turn may be why the downstream hard-split path (keyed off heading-delimited sections) also never triggers.

---

### 2.3 `PUT /api/knowledge/:id` returns HTTP 200 instead of documented 409 for non-editable formats — MEDIUM (found by Ali)

**What's broken:** §6.7 states the non-editability rule for PDF/DOCX/CSV/crawled-URL documents is "enforced in BOTH places — the console hides the button and `PUT /api/knowledge/:id` returns 409." The API side does not do this.

**Evidence (verbatim from Ali's report):**

List confirmed editable flags were correct (`01/04/06` md/txt = `true`; `02` pdf / `03` docx / `12` csv = `false`). Calling `PUT /api/knowledge/9cd82166-fbc7-42ae-8e97-9218704454c1` (doc 02, the PDF, `editable:false`) with `{"content":"x"}`:

> `{"httpStatus":200,"body":{"document":{"id":"9cd82166-...","title":"02-clinichms-pricing.pdf","content":"ClinicHMS Pricing Plans...(original text, unchanged)...","updatedAt":"2026-09-29T02:13:59.687Z"},"reembedded":false}}`

Got HTTP 200, not 409. Repeated with the same result. Cross-checked via a fresh `list`: `updatedAt` unchanged, `content` still original — no data was corrupted, the patch was silently no-op'd rather than applied or rejected.

**Why it matters:** No data corruption occurred, but the documented API contract isn't honored. A caller of the API (e.g. the partner's dashboard, built against the documented 409) cannot distinguish "saved" from "silently rejected" — it would need to diff the response against what it sent to notice nothing changed.

---

### 2.4 Job-cancellation endpoint can report "cancelled" for a job that finishes normally moments later — MEDIUM, API contract only (found by Asad)

**What's broken:** Calling the cancel endpoint on a job that is about to finish anyway can return a confident `"cancelled"` status, but the job actually completes successfully immediately afterward and overwrites that status to `"done"` — with no data corruption.

**Evidence (verbatim from Asad's report):**

Re-uploaded `07-storepulse-user-guide.pdf` (already present, exercising the replace/rollback path), immediately called cancel:
- Cancel `DELETE` response: `httpStatus 200`, `status:"cancelled"`, `error:"Cancelled by user"`, `finishedAt` timestamp.
- The very next `jobs` poll for the **same job id** showed `status:"done"`, `error:null`, `itemsDone/Total` advanced from `1/1` to `2/2`.
- `list test-asad` showed exactly one row for the document (`chunkCount:2`, `status:"ready"`) — no duplicate, no orphan. **Data integrity held.**

**Why it matters:** Flagged explicitly as a misleading API contract, not data corruption — confirmed by Asad. A caller trusting the `200`/`"cancelled"` response (e.g. a console UI telling the user "import cancelled") would report the wrong outcome to the business while the document was actually fully re-ingested with new content. Asad noted a test limitation: could not exercise cancelling a slower/larger job (e.g. mid-OCR) to see the cooperative-cancel path actually stop in-progress work, since this file was too small/fast (~1–2s total).

---

## 3. Confirmed working as designed

- **Baseline grounding** (Ali): all 6 factually-correct answers across ClinicHMS/StorePulse pricing, refunds, support hours, appointment reminders, with plausible sourcing.
- **Hallucination guard on unreleased products** (Ali): "How much does Nyron Connect cost?" correctly declined with no invented price — *"Nyron Connect has not been released yet, so there is no pricing or availability information for it today."*
- **Off-topic rejection / threshold separation** (Haseeb): weather and tax questions declined (`sources:[]`); after uploading an off-topic recipe document, ClinicHMS questions still answered without recipe contamination, and the recipe question correctly retrieved *only* the recipe doc. Distances cleanly separated: off-topic query against the recipe chunk = 0.514 (rejected); on-topic recipe query = 0.299–0.342 (kept).
- **Heading-misdetection guard** (Adan): label/value lines ("Email:", "Phone:", "Website:") and bare URLs never misclassified as headings across 16 checked results; contact info preserved verbatim in chunk previews.
- **Runt-paragraph forward merge** (Adan): a tiny first paragraph ("See below for details.") correctly merged forward into the real content of its section rather than surviving as an isolated, weakly-matching fragment.
- **OCR pipeline for scanned PDFs** (Asad): a 95KB, zero-extractable-text scanned PDF showed a genuine `ocr` processing stage in the job trace, and the resulting chat answer correctly covered all 8 onboarding-checklist steps.
- **Sequential job processing** (Asad): 3 files uploaded in one batch processed strictly one-at-a-time (`queued→processing→done`) across 14 polls, zero concurrency violations, consistent with the documented concurrency-1 design.
- **The replace mechanic itself** (Haseeb, and confirmed independently by Abdullah in Part 1d below): re-uploading a same-titled document reuses the same `sourceId`, fully purges the old content (not just outranks it — confirmed via `search`), and the agent's answer reflects only the new value.
- **Threshold separation between on/off-topic content** (Haseeb): distances cleanly on either side of `MAX_DISTANCE=0.43` with no overlap in the cases tested.
- **Language independence** (Abdullah, Part 1a below): `replyLanguage:"en"` forces English replies regardless of the caller's language; `replyLanguage:"auto"` correctly mirrors the caller in both directions; `uiLocale` independently controls dashboard-facing validation-error language with no `&locale=` param needed.
- **Human-readable error surfacing** (Abdullah, Part 1b below): both an unsupported extension and a zero-byte file were rejected with clean, human sentences, not raw validation internals.
- **Mixed-outcome multi-file upload** (Abdullah, Part 1c below): one bad file in a 3-file batch did not block the two good files from completing.

---

## 4. Product-quality observations (not bugs)

**Phrasing-boundary coverage gap for natural phone-caller openers** (found by Ali, `test-ali`). With `MAX_DISTANCE = 0.43` fixed and measured per §6.3, roughly **half of natural "who are you / what do you do" phone-caller openers get declined** rather than answered — not because the information isn't present, but because the query lacks the literal brand keyword "nyron" needed for the keyword half of the hybrid RRF re-rank to pull the right chunk close enough.

Evidence table (best-distance, whether kept ≤0.43, whether chat answered):

| Query | Best distance | kept? | Chat answered? | Margin |
|---|---|---|---|---|
| "what type of services you provide" | 0.4318 | No | No — declined | 0.0018 over |
| "what products do you offer" | 0.3944 | Yes | Yes — correct | 0.036 under |
| "give me overview about your company" | 0.4463 | No | No — declined | 0.016 over |
| "tell me about your company" | 0.4675 | No | No — declined | 0.037 over |
| "what does nyron do" | 0.2986 | Yes | Yes — correct | 0.131 under |
| "who are you and what do you sell" | 0.4422 | No | No — declined | 0.012 over |
| "what is nyron about" | 0.2960 | Yes | Yes — correct | 0.134 under |

4 of 7 phrasings decline, every one by a margin under 0.04. Every declined query's closest chunk was the same untitled `12-storepulse-plans.csv` price-table fragment (no heading breadcrumb) — nearer than the genuinely relevant About Us/Our Products chunk by 0.02–0.05. Queries containing "nyron" land around 0.30 (comfortably inside) via keyword overlap; generic paraphrases without that anchor cluster at 0.44–0.47.

This is **expected/by-design behavior** — the threshold is measured, not guessed (§6.3), and Ali's own baseline test confirmed "what products do you offer" (using the document's own vocabulary) clears the bar comfortably, ruling out a retrieval malfunction. It is real evidence, though, that a caller who doesn't happen to say the company name by name has roughly even odds of being deflected on a natural opening question — worth knowing for anyone tuning `MAX_DISTANCE` or chunk headings against real call transcripts later (§9.1).

---

## 5. Abdullah's own test cluster — full detail (`test-abdullah`, `test-abdullah-replace-check`)

### 5a. Language independence (§7)

Setup: uploaded `02-clinichms-pricing.pdf` and `11-clinichms-faq-it.md` (Italian) to `test-abdullah`, both reached `status:"done"`.

`config-get test-abdullah` (before any changes) — defaults confirmed:
```json
{"config":{"businessName":"this business","purpose":"","tone":"professional","timezone":"UTC","uiLocale":"en","replyLanguage":"auto","hours":null,"escalation":null,"capabilities":{},"exists":false},"locale":"en"}
```

**Test 1 — forced English regardless of caller language.** `config-put {"replyLanguage":"en"}`, then `chat "Quanto costa ClinicHMS Starter?"` (Italian question):
```json
{"reply":"Our Starter plan costs 89 euros per month for up to 2 practitioners. Every plan also includes a 14-day free trial with no credit card required to start.","model":"gemini:gemini-3.5-flash-lite","sources":["11-clinichms-faq-it.md","02-clinichms-pricing.pdf"]}
```
English reply to an Italian question, grounded correctly (89). **PASS.**

**Test 2 — `auto` mirrors the caller both ways.** `config-put {"replyLanguage":"auto"}`, same Italian question:
```json
{"reply":"Il piano Starter costa 89 euro al mese e include fino a 2 professionisti. Ogni piano prevede anche una prova gratuita di 14 giorni, senza necessità di inserire la carta di credito.","sources":["11-clinichms-faq-it.md","02-clinichms-pricing.pdf"]}
```
Then `chat "How much is ClinicHMS Starter?"` (English):
```json
{"reply":"Our Starter plan is priced at 89 euros per month for up to two practitioners. It includes patient records, appointment scheduling, reminders, and standard email support.","sources":["02-clinichms-pricing.pdf","11-clinichms-faq-it.md"]}
```
Italian question → Italian reply; English question → English reply, same `auto` setting. **PASS**, confirms mirroring in both directions.

**Test 3 — `uiLocale` independence for validation errors.** `config-put {"uiLocale":"it"}`, then (no `&locale=` param anywhere) `config-put {"tone":"not-a-real-tone"}`:
```json
{"httpStatus":400,"body":{"error":"Si è verificato un errore","details":["Scegli tra: professional, friendly, concise, formal."],"locale":"it"}}
```
Error text is Italian ("An error occurred" / "Choose from: professional, friendly, concise, formal.") purely from the saved `uiLocale`, with no locale param passed on the request. **PASS**, confirms the documented precedence (§7): saved `uiLocale` outranks `Accept-Language` for dashboard-facing messages.

### 5b. Human-readable errors (§6.16)

Created a zero-byte `empty.txt` and a renamed `bad.exe` in scratch, uploaded each separately:
```json
// bad.exe
{"httpStatus":400,"body":{"jobs":[],"rejected":[{"fileName":"bad.exe","error":"That file type is not supported. Accepted: .pdf .docx .txt .md .csv."}]}}
// empty.txt
{"httpStatus":400,"body":{"jobs":[],"rejected":[{"fileName":"empty.txt","error":"That file is empty."}]}}
```
Both rejected immediately (pre-job, in the `rejected` array) with clean, human sentences — no raw validation internals or stack traces leaked. Note: the empty file was rejected at upload time rather than failing in a background job as anticipated; either path is consistent with §6.16 since the message is clean either way.

### 5c. Multi-file mixed-outcome upload (§6.6)

One `upload` call with `05-availability-and-support-hours.md`, `12-storepulse-plans.csv`, and `empty.txt` together:
```json
{"httpStatus":202,"body":{"jobs":[{"title":"05-availability-and-support-hours.md",...},{"title":"12-storepulse-plans.csv",...}],"rejected":[{"fileName":"empty.txt","error":"That file is empty."}]}}
```
`jobs wait` confirmed both good files reached `status:"done"` (05 → 6 chunks, 12 → 1 chunk); the bad file never entered the job queue at all and did not block or delay the other two. **PASS.**

### 5d. Replace-fixture sanity check (§6.10)

Fresh tenant `test-abdullah-replace-check`. Uploaded `02-clinichms-pricing.pdf`, waited, asked:
```json
{"reply":"Our Starter plan is priced at 89 euro per month for up to two practitioners. ...","sources":["02-clinichms-pricing.pdf"]}
```
Then uploaded `replace-test-v2/02-clinichms-pricing.pdf` (now correctly matching the original's filename after the fixture fix), waited, asked again:
```json
{"reply":"Our Starter plan is priced at 99 euros per month and supports up to two practitioners. Every plan also includes a 14-day free trial with no credit card required to start.","sources":["02-clinichms-pricing.pdf"]}
```
`list` confirmed a single document row, same `sourceId` (`896f96e6-baec-45a8-aebd-02d166c15f58`) across both jobs, `chunkCount:1`, no duplicate. Price moved cleanly from 89 → 99. **PASS** — confirms the orchestrator's fixture rename fix actually works; the replace mechanic itself functions correctly once filenames match.

---

## 6. Test methodology note

- Five testers, one isolated tenant per tester (`test-ali`, `test-adan`, `test-asad`, `test-haseeb`, `test-abdullah` + `test-abdullah-replace-check`), no cross-contamination of knowledge bases.
- All testing done through a shared Node CLI (`chat`, `upload`, `jobs wait`, `list`, `config-get`, `config-put`) making plain HTTP calls against the already-running dev server — no source file under `src/`, `prisma/`, or elsewhere in the project was read, edited, or created as part of testing, other than files under `test-docs/` (read-only, per tester instructions) and this report.
- One test-fixture bug was found and fixed mid-sweep: `test-docs/replace-test-v2/clinichms-pricing.pdf` originally had a filename that didn't match `test-docs/02-clinichms-pricing.pdf`, so the replace mechanic (title = filename) never fired during Haseeb's original test — worked around at the time by testing with a copy, then permanently fixed by renaming the actual fixture file to `02-clinichms-pricing.pdf`. Abdullah's Part 1d re-verified the fix works end-to-end on a fresh tenant.
- No code fixes are proposed in this report — findings only, for the maintaining engineer to triage.

---

*Compiled by Abdullah (`test-abdullah`), the fifth tester, from the raw reports of Ali, Adan, Asad, and Haseeb plus this tester's own Part 1 cluster.*
