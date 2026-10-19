# Hand-off to the backend — what the engine stood in for, and what changes

Written for Abdul Haseeb. The engine side of "the agent takes a request" (appointments and
call-backs) is built and tested end to end. To do that without waiting for `tenant_core`, a few
jobs that belong to the backend are done **locally, behind fixed interfaces**. This document is
the complete list of them and of what changes on each side when the real thing arrives.

Everything marked **stand-in** lives in `src/lib/standins/` (the only place that knows the data
sits in `ai_engine`). Replacing a stand-in is replacing that folder; nothing else imports the
tables directly.

## 1. What the engine does now (so you know what you are receiving)

* The business configures **what the agent collects** — a checklist of details per request type
  (appointment, call-back), custom fields, its services and staff list, an industry preset as the
  starting point. Stored as one JSON document, `agent_configs.collect`, versioned
  (`collect_version`, +1 per save). English and Urdu wording for every label and question.
* In a conversation (chat or voice) the engine asks for the missing details one at a time and
  validates each (phone → international form, email, number range, a date/time inside the
  opening hours in the business's time zone, a choice from the business's own list). **The
  request is saved as soon as every required detail is in** — the engine then reads it back, and a
  correction by the customer updates the same record (it never creates a second one). Optional
  answers asked after the save update it too.
* **The AI never books anything.** A saved request has status `requested`; the customer is told
  "we've noted it, the team will confirm" and is given a reference (`AP-4K7Q2` / `CB-9XM3T`). A
  person confirms it in the dashboard. This is deliberate (CLAUDE.md §6.11).
* Saving is idempotent (`submissionKey`), so a retried turn never creates a second request.
* Only English and Urdu exist (UI and agent). `uiLocale` ∈ {en, ur}; `replyLanguage` ∈ {en, ur}
  (`auto` and `it` are gone — please do not send them).

## 2. Stand-ins and what replaces each

| Stand-in (engine) | Table(s) | What the real backend does | Engine change when it arrives |
| --- | --- | --- | --- |
| `standins/customers.js` — `upsertCustomer(tenantId, {name, phone, email})` | `ai_engine.customers`, unique `(tenant_id, phone)` | Owns end-customers (`end_customers`), de-duplicated by phone | Point `upsertCustomer` at the backend; engine keeps passing the same three fields and gets an id back |
| `standins/records.js` — `createRecord / updateRecordDetails / withdrawRecord / listRecords / getRecord / updateRecordStatus` | `ai_engine.records` | Owns bookings/call-back requests, the staff screen, the status workflow (`requested → confirmed → done`, `cancelled`) | `createRecord` becomes a call (or event) to the backend; `GET/PATCH /api/records*` in the engine are test-console routes and go away — the dashboard talks to the backend |
| `standins/events.js` — `emitEngineEvent({type, tenantId, data})` | none (in-process listeners) | Receives engine → backend events (`record.submitted`, `record.updated`) | Replace the body with the signed, retried, outbox-backed POST described in `backend-events.openapi.yaml`. Call sites do not change |
| `tenant/config.js` reading `agent_configs` (incl. `collect`) | `ai_engine.agent_configs` | Stores the **versioned** agent config the dashboard edits | Make `getAgentConfig()` read from the backend; `saveCollectConfig()` becomes a pass-through. The JSON shapes below are the contract |
| `tenant/registry.js` `assertTenantServiceable()` | none | Suspension, plan, quota | Edit that one function; routes already call `requireServiceableTenant()` |
| `tenantId` | — | Real tenant identity from auth | Engine still treats it as an opaque string `^[A-Za-z0-9_-]{1,100}$`; the console passes it as a query parameter today |

## 3. Shapes to agree on

**Collect configuration** (`PUT /api/collect?tenantId=…`, body `{ "collect": { … } }`, whole document
replaced on every save; `GET` returns `{ collect, version, catalog, locale }`):

```jsonc
{
  "enabled": true,
  "industry": "dental",                              // preset it started from, informational
  "services": [{ "id": "root_canal", "label": { "en": "Root canal", "ur": "روٹ کینال" } }],
  "staff":    [{ "id": "dr_ali",     "label": { "en": "Dr Ali",      "ur": "ڈاکٹر علی" } }],
  "customFields": [{ "id": "c_parking", "type": "yesno", "label": {…}, "question": {…}, "sensitive": false }],
  "recordTypes": {
    "appointment": { "enabled": true, "fields": [{ "id": "name", "required": true }, { "id": "phone", "required": true }, …] },
    "callback":    { "enabled": true, "fields": […] }
  }
}
```

`catalog` (in the GET response) lists every field, request type and industry preset with English
and Urdu wording — the dashboard should draw its checklist from it, not hardcode field names.
Limits: ≤ 12 fields per request type, ≤ 10 custom fields, ≤ 60 services/staff entries; the engine
refuses a save that would leave a request type with no way to reach the customer (no phone).
Validation errors come back translated in the requested `locale`.

**Request record** (what `createRecord` stores and what you will receive):

```jsonc
{
  "id": "…", "tenantId": "…", "reference": "AP-4K7Q2", "type": "appointment",
  "status": "requested",                       // requested | confirmed | done | cancelled
  "channel": "voice",                          // chat | voice (whatsapp later)
  "language": "ur",                            // en | ur — the language the customer was served in
  "data": { "name": "…", "phone": "+923001234567", "service": "root_canal", "datetime": "2026-10-22T17:00" },
  "summary": "Ahmed · Root canal · Thursday, 22 October 2026 at 5:00 pm",
  "scheduledLocal": "2026-10-22T17:00",        // the business's wall clock — a STRING on purpose
  "timezone": "Asia/Karachi",
  "configVersion": 7,                          // collect_version it was taken under
  "conversationId": "…", "submissionKey": "…", "createdAt": "…"
}
```

`scheduledLocal` is a wall-clock string in the business's time zone, not an instant: turning it
into an instant (and checking the slot is actually free) is the backend's decision, because only
the backend knows the calendar.

**Updates while it is still `requested`:** the engine may update a saved request's `data`, `summary`
and `scheduledLocal` (the customer corrected a detail) or withdraw it (status `cancelled`, only on
a strong "cancel it"). Both are refused once the status is anything but `requested`, so the real
backend must keep that rule: a person's confirm freezes what the customer can change from the
conversation. Each emits `record.updated` (`detailsChanged: true` for a detail edit).

**Events** (envelope `{ id, type, tenantId, occurredAt, data }`): `record.submitted`
(`recordId, recordType, reference, conversationId`) and `record.updated` (`recordId, status`).
Event data carries ids and reference numbers, **not** the customer's details; the backend reads
those from the record. Open question for you: do you want the details in the event instead?

## 4. What is NOT done on the engine side (so you do not assume it)

* **No backend contract surface.** The `/internal/*` routes, the SSE streaming protocol, claim /
  release of conversations and the delivery outbox from your OpenAPI files are **not built**. The
  console's own `/api/chat`, `/api/knowledge`, `/api/agent-config`, `/api/collect`, `/api/records`
  are the only routes. Say which of the contract routes you need first and they can be built
  against the stand-ins' interfaces.
* **No WhatsApp.** The records and events already carry `channel`; the delivery of a confirmation
  to the customer's phone (WhatsApp or SMS) is not built and needs your decision on who sends it.
* **No Twilio** (unchanged — CLAUDE.md §9.2).
* **No slot availability.** The engine checks opening hours only; "is Thursday 5 pm free" is the
  backend's calendar.
* **Usage counting** (minutes, messages, records) is not emitted yet; the event shape for billing
  has to be agreed first (CLAUDE.md §9.2 asks for this early).
* **Conversation memory after a long pause** and the Urdu retrieval quality have known gaps — see
  CLAUDE.md §8.

## 5. Migration note

One hand-written migration, `20261020100000_two_languages_and_collect`: adds
`agent_configs.collect` and `collect_version`, `conversations.collect_draft` (the in-progress
details of one conversation, 30-minute expiry), the `customers` and `records` tables, and relabels
any Italian/`auto` leftovers (reply/UI language → `en`, Italian text-search label → `english`). The generated diff's `DROP INDEX` for the HNSW index was removed (CLAUDE.md §6.1);
`npm run db:check` must pass after applying it.
