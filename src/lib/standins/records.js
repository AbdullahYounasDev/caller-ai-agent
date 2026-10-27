import { randomInt } from "node:crypto";
import { prisma } from "@/lib/db";
import { upsertCustomer } from "./customers";
import { emitEngineEvent } from "./events";
import { agentScope } from "@/lib/tenant/agent-request";

/**
 * STAND-IN for the backend's bookings / callback requests and the staff screen that works
 * through them (see ./README.md).
 *
 * A request is saved as "requested" and a PERSON moves it on. The agent has no function
 * here that confirms anything: `createRecord` is the only thing respond.js calls, and it can
 * only ever produce status "requested" (CLAUDE.md §6.11 — the model never silently mutates
 * tenant data, and never tells a customer something is booked).
 */

export const RECORD_STATUSES = ["requested", "confirmed", "done", "cancelled"];

/** Where a request may be moved. A cancelled one can be reopened; nothing skips "confirmed" to "done". */
const TRANSITIONS = {
  requested: ["confirmed", "cancelled"],
  confirmed: ["done", "cancelled", "requested"],
  done: ["confirmed"],
  cancelled: ["requested"],
};

export const REFERENCE_PREFIX = { appointment: "AP", callback: "CB", order: "OR" };
// No 0/O/1/I/L: a reference is read aloud and written on a slip of paper.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newReference(type) {
  let code = "";
  for (let i = 0; i < 5; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${REFERENCE_PREFIX[type] ?? "RQ"}-${code}`;
}

const isUniqueViolation = (err, field) => err?.code === "P2002" && String(err?.meta?.target ?? "").includes(field);

/**
 * Save a confirmed request. Idempotent on `submissionKey`: the same confirmation twice —
 * a retried turn, a double click — is one row and the same reference.
 *
 * @param {string} tenantId
 * @param {object} input
 * @param {string} input.submissionKey
 * @param {string} input.type
 * @param {Record<string, string>} input.values   validated values by field id
 * @param {string} input.summary
 * @param {string|null} input.scheduledAt          "2026-10-22T17:00", the business's wall clock
 * @param {string} input.language
 * @param {string|null} [input.agentId]          the agent that took it (null = default agent)
 * @param {string|null} [input.conversationId]
 * @param {string} [input.channel]
 * @param {string} [input.timezone]
 * @param {number} [input.configVersion]
 * @returns {Promise<{id: string, reference: string, created: boolean}>}
 */
export async function createRecord(tenantId, input) {
  if (!tenantId) throw new Error("createRecord requires a tenantId");
  const existing = await prisma.record.findUnique({
    where: { tenantId_submissionKey: { tenantId, submissionKey: input.submissionKey } },
    select: { id: true, reference: true },
  });
  if (existing) return { ...existing, created: false };

  const customer = await upsertCustomer(tenantId, {
    name: input.values.name ?? null,
    phone: input.values.phone ?? null,
    email: input.values.email ?? null,
  });

  for (let attempt = 0; ; attempt++) {
    try {
      const row = await prisma.record.create({
        data: {
          tenantId,
          reference: newReference(input.type),
          type: input.type,
          agentId: input.agentId ?? null,
          conversationId: input.conversationId ?? null,
          customerId: customer.id,
          channel: input.channel ?? "chat",
          language: input.language === "ur" ? "ur" : "en",
          data: input.values,
          summary: input.summary ?? "",
          scheduledLocal: input.scheduledAt ?? null,
          timezone: input.timezone ?? "UTC",
          configVersion: input.configVersion ?? 0,
          submissionKey: input.submissionKey,
        },
        select: { id: true, reference: true },
      });
      emitEngineEvent({ type: "record.submitted", tenantId, data: { recordId: row.id, recordType: input.type, reference: row.reference, agentId: input.agentId ?? null, conversationId: input.conversationId ?? null } });
      return { ...row, created: true };
    } catch (err) {
      // Two near-simultaneous confirmations: the other one won; hand back its row.
      if (isUniqueViolation(err, "submission_key")) {
        const winner = await prisma.record.findUnique({
          where: { tenantId_submissionKey: { tenantId, submissionKey: input.submissionKey } },
          select: { id: true, reference: true },
        });
        if (winner) return { ...winner, created: false };
      }
      // A reference collision (1 in ~25 million per tenant): draw another.
      if (isUniqueViolation(err, "reference") && attempt < 4) continue;
      throw err;
    }
  }
}

/**
 * The customer corrected a detail after the request was saved: rewrite the row — but only
 * while it is still "requested". Once a person has confirmed it, the agent must not quietly
 * change what the team acted on; the caller is told a team member will adjust it.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {{values: Record<string, string>, summary?: string, scheduledAt?: string|null}} patch
 * @returns {Promise<{ok: boolean, reason?: "not_found"|"locked"}>}
 */
export async function updateRecordDetails(tenantId, id, patch) {
  if (!tenantId) throw new Error("updateRecordDetails requires a tenantId");
  const current = await prisma.record.findFirst({ where: { tenantId, id }, select: { status: true } });
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status !== "requested") return { ok: false, reason: "locked" };
  const customer = await upsertCustomer(tenantId, {
    name: patch.values.name ?? null,
    phone: patch.values.phone ?? null,
    email: patch.values.email ?? null,
  });
  // Conditional on still being "requested", so a staff confirmation landing at the same moment wins.
  const { count } = await prisma.record.updateMany({
    where: { id, tenantId, status: "requested" },
    data: { data: patch.values, summary: patch.summary ?? "", scheduledLocal: patch.scheduledAt ?? null, customerId: customer.id },
  });
  if (!count) return { ok: false, reason: "locked" };
  emitEngineEvent({ type: "record.updated", tenantId, data: { recordId: id, status: "requested", detailsChanged: true } });
  return { ok: true };
}

/** The customer withdrew their own request ("forget it"): cancel it, but only while it is still "requested". */
export async function withdrawRecord(tenantId, id) {
  if (!tenantId) throw new Error("withdrawRecord requires a tenantId");
  const { count } = await prisma.record.updateMany({ where: { id, tenantId, status: "requested" }, data: { status: "cancelled" } });
  if (!count) return { ok: false, reason: "locked" };
  emitEngineEvent({ type: "record.updated", tenantId, data: { recordId: id, status: "cancelled" } });
  return { ok: true };
}

const SELECT = {
  id: true,
  reference: true,
  type: true,
  status: true,
  agentId: true,
  conversationId: true,
  channel: true,
  language: true,
  data: true,
  summary: true,
  scheduledLocal: true,
  timezone: true,
  createdAt: true,
  updatedAt: true,
  customer: { select: { id: true, name: true, phone: true, email: true } },
};

/**
 * @param {string} tenantId
 * @param {{status?: string, type?: string, agentId?: string|null, includeUnassigned?: boolean, take?: number, skip?: number}} [filter]
 *        agentId: only the requests that agent took; omitted = every agent's. The status
 *        counts follow the same agent filter, so the badges match the list beside them.
 *        includeUnassigned: also rows with no agent — they were taken by the DEFAULT agent
 *        before it had a row, so pass it when agentId is the default agent.
 * @returns {Promise<{data: object[], total: number, counts: Record<string, number>}>}
 */
export async function listRecords(tenantId, { status, type, agentId, includeUnassigned = false, take = 50, skip = 0 } = {}) {
  if (!tenantId) throw new Error("listRecords requires a tenantId");
  const scope = { tenantId, ...agentScope(agentId, includeUnassigned) };
  const where = { ...scope, ...(RECORD_STATUSES.includes(status) ? { status } : {}), ...(type ? { type } : {}) };
  const [data, total, grouped] = await Promise.all([
    prisma.record.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(take, 1), 100), skip: Math.max(skip, 0), select: SELECT }),
    prisma.record.count({ where }),
    prisma.record.groupBy({ by: ["status"], where: scope, _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(RECORD_STATUSES.map((s) => [s, 0]));
  for (const g of grouped) counts[g.status] = g._count._all;
  return { data, total, counts };
}

/** @returns {Promise<object|null>} null for an id that is another tenant's */
export async function getRecord(tenantId, id) {
  return prisma.record.findFirst({ where: { tenantId, id }, select: SELECT });
}

/**
 * Move a request along. Returns the row, or a reason it could not be moved.
 *
 * @returns {Promise<{ok: true, record: object}|{ok: false, reason: "not_found"|"invalid_status"|"invalid_transition"}>}
 */
export async function updateRecordStatus(tenantId, id, status) {
  if (!RECORD_STATUSES.includes(status)) return { ok: false, reason: "invalid_status" };
  const current = await prisma.record.findFirst({ where: { tenantId, id }, select: { status: true } });
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status === status) return { ok: true, record: await getRecord(tenantId, id) };
  if (!TRANSITIONS[current.status]?.includes(status)) return { ok: false, reason: "invalid_transition" };

  // Conditional on the status we read, so two staff members clicking at once cannot both win.
  const { count } = await prisma.record.updateMany({ where: { id, tenantId, status: current.status }, data: { status } });
  if (!count) return { ok: false, reason: "invalid_transition" };
  emitEngineEvent({ type: "record.updated", tenantId, data: { recordId: id, status } });
  return { ok: true, record: await getRecord(tenantId, id) };
}
