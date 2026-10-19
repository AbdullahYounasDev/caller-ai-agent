# Stand-ins for the backend

Everything in this folder does a job that belongs to the **backend** (the partner's
`tenant_core` side: customers, bookings, staff dashboard, notifications), done here, locally,
so the whole "the agent takes a request" flow can be built and tested end to end before that
side exists. Nothing outside this folder knows the data lives in `ai_engine`.

| File | Stands in for | The real thing |
| --- | --- | --- |
| `customers.js` | the backend's `end_customers` | a `tenant_core` table, found by phone number |
| `records.js` | the backend's bookings / callback requests, and the staff screen that confirms them | a `tenant_core` table + dashboard API (`PATCH …/records/:id`) |
| `events.js` | the engine → backend signed event delivery (`POST /internal/events`) | the outbox + HMAC sender described in docs/handoff-to-backend.md |

Rules while they live here:

* the AI **never reads these tables back** — what it knows about a customer is the conversation;
* callers import from `@/lib/standins/*` only — never `prisma.record` directly — so replacing
  them is replacing this folder;
* every function takes `tenantId` first and scopes by it.

The complete list of what the backend has to build to replace them is
[`docs/handoff-to-backend.md`](../../../docs/handoff-to-backend.md).
