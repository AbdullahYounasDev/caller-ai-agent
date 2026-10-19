import { randomInt } from "node:crypto";
import { prisma } from "@/lib/db";
import { upsertCustomer } from "./customers";
import { emitEngineEvent } from "./events";

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

export const REFERENCE_PREFIX = { appointment: "AP", callback: "CB" };
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
      emitEngineEvent({ type: "record.submitted", tenantId, data: { recordId: row.id, recordType: input.type, reference: row.reference, conversationId: input.conversationId ?? null } });
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

const SELECT = {
  id: true,
  reference: true,
  type: true,
  status: true,
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
 * @param {{status?: string, type?: string, take?: number, skip?: number}} [filter]
 * @returns {Promise<{data: object[], total: number, counts: Record<string, number>}>}
 */
export async function listRecords(tenantId, { status, type, take = 50, skip = 0 } = {}) {
  if (!tenantId) throw new Error("listRecords requires a tenantId");
  const where = { tenantId, ...(RECORD_STATUSES.includes(status) ? { status } : {}), ...(type ? { type } : {}) };
  const [data, total, grouped] = await Promise.all([
    prisma.record.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(take, 1), 100), skip: Math.max(skip, 0), select: SELECT }),
    prisma.record.count({ where }),
    prisma.record.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
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
