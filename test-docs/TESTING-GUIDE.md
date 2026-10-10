# Test Knowledge Pack — Nyron Software Solutions

A fictional company and product set, built to exercise every ingestion/retrieval
path described in `CLAUDE.md` §6. Everything here is content only — no source
files were touched. Use the test console (`npm run dev` → http://localhost:3000)
to drive all of it yourself; nothing below requires me.

**The fictional company:** Nyron Software Solutions S.r.l., Milan. Two real
products (**ClinicHMS** — clinic management, **StorePulse** — retail/inventory)
plus one *unreleased* one (**Nyron Connect**, mentioned but never priced — a
built-in hallucination trap).

---

## File inventory

| File | Format | Editable? | What it's for |
|---|---|---|---|
| `01-company-overview.md` | Markdown | ✅ | General grounding: about us, products, contact, milestones |
| `02-clinichms-pricing.pdf` | PDF | ❌ | ClinicHMS plans/pricing table. Also **v1** for the replace test |
| `03-storepulse-pricing-plans.docx` | DOCX | ❌ | StorePulse plans/pricing, real Word Heading 1/2 styles + table |
| `04-returns-and-refund-policy.txt` | Plain text | ✅ | Heading-detection edge cases (see below) |
| `05-availability-and-support-hours.md` | Markdown | ✅ | Support hours, SLA table, regions |
| `06-clinichms-faq.md` | Markdown | ✅ | FAQ + a deliberate "runt paragraph" under one heading |
| `07-storepulse-user-guide.pdf` | PDF | ❌ | Multi-page guide with one ~1,400-character run-on sentence |
| `08-storepulse-price-list-conflict.txt` | Plain text | ✅ | States StorePulse Pro at **€179/mo** — conflicts with file 03's €149/mo on purpose |
| `09-off-topic-recipe.txt` | Plain text | ✅ | A pasta recipe — totally unrelated to the business |
| `10-nyron-onboarding-scanned.pdf` | PDF (image-only) | ❌ | No text layer at all — forces the OCR path |
| `11-clinichms-faq-it.md` | Markdown, Italian | ✅ | Italian-language content for language testing |
| `12-storepulse-plans.csv` | CSV | ❌ | Same plan data in tabular form |
| `replace-test-v2/02-clinichms-pricing.pdf` | PDF | ❌ | **v2** of file 02 — same filename, higher prices — for the replace test |

One thing worth knowing before you start: for file uploads, the console sets
the document **title to the exact filename** (`src/app/api/knowledge/route.js:166`).
There's no separate title field for uploads. That's *why* the replace-test
file lives in its own subfolder — it has to be named `02-clinichms-pricing.pdf`
too, so re-uploading it collides with file 02's title on purpose. (Correcting
an earlier mistake: this file was originally named without the `02-` prefix,
so it silently created a second document instead of replacing the first —
caught during testing, fixed by renaming it to match exactly. Typed-text
entries are different — their title is whatever you type in the "Write" tab,
independent of any filename.)

---

## Setup

```bash
npm run db:up
npm run prisma:migrate
npm run dev
```

Open http://localhost:3000. You'll create/select an agent config, then use the
**Knowledge** panel to upload/write documents and the **Chat** panel to ask
questions against them.

---

## Test scenarios

### 1. Baseline grounding, one format at a time

Upload files 01, 02, 03, 04, 05, 06, 12 one at a time (or all together — each
gets its own background job, §6.6). For each, ask a question only that
document can answer and confirm the answer is correct and doesn't drift:

- "How much is the ClinicHMS Growth plan and what does it include?" → 219
  euro/month, up to 10 practitioners, billing/invoicing, lab integration,
  pharmacy module *(file 02)*
- "How much is StorePulse Pro and how many stores does it cover?" → 149
  euro/month, up to 5 stores *(file 03 / file 12 — should agree with each
  other since you haven't uploaded file 08 yet)*
- "Can I get a refund on an annual plan?" → 30-day money-back guarantee
  *(file 04)*
- "What are your support hours for the Growth plan?" → Mon–Fri 08:00–20:00
  CET *(file 05)*
- "Does ClinicHMS send appointment reminders?" → yes, SMS + email, 24h and 2h
  before *(file 06 — also see Test 4)*
- "How much does Nyron Connect cost?" → should say it isn't released / no
  pricing exists yet, **not** invent a number *(file 01 — hallucination trap)*

### 2. Editability rule (§6.7)

In the Knowledge list, confirm the Edit button appears **only** for the `.md`
and `.txt` files (01, 04, 05, 06, 08, 09, 11) and is absent for the PDFs, the
DOCX, and the CSV. Then try `PUT /api/knowledge/:id` directly against a PDF's
id (e.g. with curl + your `INTERNAL_API_KEY` from `.env`) and confirm it
returns **409**, not just that the button is hidden.

### 3. Heading-detection edge cases (§6.4)

Upload `04-returns-and-refund-policy.txt`. Its real headings ("Free Trial",
"Monthly Subscriptions", "Support Contact", etc.) are short, unpunctuated,
and followed by a blank line — they should each seed their own chunk
breadcrumb. The three lines under "Support Contact" —
`Email: support@nyronsoftware.com`, `Phone: ...`, `Website: ...` — look
heading-shaped (short, no terminal punctuation) but each has an internal
colon, so they must **not** be split out as their own headings or silently
dropped. Ask "What's your support email?" and confirm the answer comes back
correctly — if that line had been misclassified as a heading, its text would
never have made it into any chunk's body (§6.4 describes exactly this
failure mode).

### 4. Runt-paragraph merge (§6.4)

Upload `06-clinichms-faq.md`. Under "## Appointment Reminders" there's a
one-line paragraph ("See below for details.") immediately followed by the
real content paragraph. Ask "Tell me about appointment reminders" and check
that the answer includes the full detail (SMS/email timing, template
customization) — not just "see below," which would indicate the runt never
got merged forward into its section.

### 5. Long run-on sentence / hard split (§6.4)

Upload `07-storepulse-user-guide.pdf`. Section 4 ("Onboarding Walkthrough")
is a single ~1,400-character sentence with no period until the very end. Ask
"Walk me through the StorePulse onboarding process" and read the answer
closely for a clean break — no sentence should be truncated mid-word or
duplicated. If you have access to the retrieval debug endpoint
(`/api/knowledge/search`) or the eval scripts, inspect this document's chunks
directly to confirm the split point carries the overlap correctly.

### 6. OCR path (§6.5)

Upload `10-nyron-onboarding-scanned.pdf`. It's a single full-page image with
**zero embedded text** (verified — extracting it with pdfjs returns 0
characters), so it should hit `looksScanned()` and switch to the OCR stage.
Watch the job progress: it should report an `ocr` stage (not just
`extracting`) before completing. Once done, ask "What's on the onboarding
checklist?" and confirm the 8 checklist items and the contact block come back
correctly — that's Tesseract reading the rendered image, not a paste of raw
text.

### 7. Background jobs and progress (§6.6)

Upload several files at once (e.g. 02, 03, 07, 10 together). Confirm:
- each gets its own job and its own progress bar,
- they process **one at a time**, not in parallel (concurrency is 1 by
  design),
- if one were corrupted, the others would still complete and only that one
  would report failure (you can test this by duplicating any PDF here and
  truncating it with a hex editor to a few KB, then uploading the broken
  copy alongside a good one).
- Reload the page mid-import — progress should still be there, not reset.

### 8. Job cancellation (§6.14)

Start an upload (ideally file 07 or 10, since they take a few seconds), then
cancel it from the console while it's still `processing`. Confirm:
- the job stops and is marked cancelled, not "failed,"
- if this was a brand-new document, no partial row/chunks are left behind,
- re-upload the same file afterward and confirm it ingests cleanly (nothing
  left over from the cancelled attempt).

### 9. Relevance threshold / off-topic rejection (§6.3)

With the business documents loaded, ask something with **no relevant
document at all**, e.g. "What's the weather in Milan today?" or "Can you
help me file my taxes?" The agent should say it doesn't have that
information — not confidently answer from the loosely-related "Milan" or
"support" mentions elsewhere in the knowledge base.

Then upload `09-off-topic-recipe.txt` (a pasta recipe) and:
- ask "How much is ClinicHMS?" — the recipe must not leak into this answer,
- ask "What's your ragù recipe?" — this *should* retrieve fine, since it's
  genuinely in the knowledge base and genuinely what was asked.

This tests that MAX_DISTANCE rejects irrelevant chunks by distance, not by
topic-matching the business.

### 10. Replace, same document (§6.10)

Upload `02-clinichms-pricing.pdf`. Ask "How much is ClinicHMS Starter?" →
expect **89 euro/month**. Now upload `replace-test-v2/02-clinichms-pricing.pdf`
— same filename, so the console should prompt "02-clinichms-pricing.pdf already
exists and will be replaced. Continue?" Confirm it. Ask the same question
again → expect **99 euro/month**, and the 89-euro figure should no longer be
retrievable at all (old chunks were deleted in the same transaction as the
new ones were written).

### 11. Cross-document conflict (§6.10, known limitation)

Upload `03-storepulse-pricing-plans.docx` (Pro = €149/mo). Wait a minute or
two, then upload `08-storepulse-price-list-conflict.txt` (Pro = €179/mo) —
different filename, so this creates a **second, separate** document rather
than replacing the first. Ask "How much is StorePulse Pro?" The agent should
notice the two sources disagree and say so (naming both figures or flagging
the discrepancy) rather than silently picking one — this is the documented
behavior for genuinely conflicting sources, as opposed to Test 10's clean
replace.

### 12. Language independence (§7)

Upload `11-clinichms-faq-it.md` (Italian). In the agent config:
- Set `uiLocale = it` and confirm the **console interface itself** switches
  to Italian, regardless of `replyLanguage`.
- Set `replyLanguage = en` and ask a question in Italian → the agent should
  reply in **English** even though the source chunk it's grounded in is
  Italian.
- Set `replyLanguage = auto` and ask the same question in Italian, then in
  English → the agent should mirror whichever language you asked in.
- Confirm the ClinicHMS pricing numbers it recalls from the Italian FAQ
  match file 02 (89 / 219 euro) — if you've already run Test 10, they should
  now match file 02's *updated* v2 numbers (99 / 249) instead, which is
  itself a good side-check that replacement fully took.

### 13. Human-readable errors (§6.16)

Try to provoke a real failure and confirm the console never shows raw
JSON/stack traces:
- Upload a file type the console rejects (rename any random file to `.exe`
  or `.zip` and try to upload it) → expect a clean, translated validation
  message.
- If you have a way to exhaust the Gemini free-tier quota (see CLAUDE.md
  §8 limitation 4 — easy to hit during a heavy testing session), try an
  upload or chat message while quota is exhausted → expect a friendly
  "usage limit" message, never a `RESOURCE_EXHAUSTED` JSON blob.

### 14. Retry a failed import (§6.15)

This one is easiest to trigger by accident: if you hit a quota error during
Test 13 on an actual upload (not chat), the document should land in a
`failed` state with a **Retry** button (only for transient errors like
quota/outage — not for a document that's simply invalid). Wait for the quota
window to reset (or switch `GEMINI_CHAT_MODEL`/use a fresh key), click
Retry, and confirm it re-embeds without asking you to re-upload the file.

### 15. Multi-file / mixed-outcome upload

Select several files at once, including a mix of good ones from this folder
and one deliberately bad one (e.g., an empty `.txt` file, or a `.pdf` renamed
to `.docx`). Confirm the good files all import successfully and only the bad
one is reported as rejected/failed — one bad file must never block the rest
of the batch (§6.6).

---

## Notes

- Titles collide **exactly on filename** for uploads — if you want to re-run
  a replace test cleanly, either delete the existing document first or reuse
  the exact same filename again.
- All prices/policies here are invented for testing and have no relation to
  any real company.
- If you add more fixtures later, keep the "one deliberate edge case per
  file" style — it's much easier to tell *which* behavior broke than when
  one giant document exercises five things at once.
