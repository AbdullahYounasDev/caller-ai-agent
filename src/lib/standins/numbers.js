import { prisma } from "@/lib/db";
import { toE164 } from "@/lib/telephony/routing";
import { forgetRoute } from "@/lib/telephony/route-cache";

/**
 * STAND-IN for the backend's phone numbers (see ./README.md, docs/handoff-to-backend.md B11).
 *
 * In production the backend buys, ports, releases and bills numbers, and keeps which agent each one
 * rings. Until it exists, the engine keeps that list here so the whole path — dialled number →
 * tenant → agent → the call — can be built and tested. The ENGINE reads it only through
 * tenant/registry.js resolveDialledNumber(); the console and /api/numbers manage it as the
 * backend's dashboard will.
 *
 * Rules kept here because they are the routing's, whoever stores the list:
 *   - an ACTIVE number belongs to exactly one tenant (phone_numbers.active_e164 is unique);
 *   - a number rings exactly one agent, which must be an ACTIVE agent of the same tenant;
 *   - a released number is kept (its calls point at it) and can be added again, by anyone.
 */

/** A stand-in cap, so a script cannot fill the table; a plan's real limit is the backend's. */
export const MAX_NUMBERS_PER_TENANT = 50;
export const MAX_NUMBER_LABEL = 60;
export const NUMBER_KINDS = ["purchased", "forwarding"];

/** Refused for a reason the owner can act on; `code` names a validation:numbers.* message. */
export class NumberRuleError extends Error {
  constructor(code, status = 400, vars) {
    super(`Number change refused: ${code}`);
    this.name = "NumberRuleError";
    this.code = code;
    this.status = status;
    this.vars = vars;
  }
}

const SELECT = {
  id: true,
  e164: true,
  label: true,
  status: true,
  kind: true,
  agentId: true,
  provider: true,
  releasedAt: true,
  createdAt: true,
  updatedAt: true,
};

const isUniqueViolation = (err) => err?.code === "P2002";

function cleanLabel(label) {
  if (label === undefined || label === null) return "";
  if (typeof label !== "string") throw new NumberRuleError("labelInvalid");
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (trimmed.length > MAX_NUMBER_LABEL) throw new NumberRuleError("labelTooLong", 400, { max: MAX_NUMBER_LABEL });
  return trimmed;
}

function readNumber(raw) {
  const parsed = toE164(raw);
  if (parsed.ok) return parsed.value;
  throw new NumberRuleError(parsed.reason === "needsCountryCode" ? "needsCountryCode" : "numberInvalid");
}

/** An agent a number may ring: one of THIS tenant's, and still answering. null = leave unlinked. */
async function checkAgent(tenantId, agentId) {
  if (agentId === null || agentId === undefined || agentId === "") return null;
  if (typeof agentId !== "string") throw new NumberRuleError("agentNotUsable");
  const agent = await prisma.agentConfig.findFirst({ where: { id: agentId, tenantId }, select: { status: true } });
  if (!agent || agent.status !== "active") throw new NumberRuleError("agentNotUsable", 400);
  return agentId;
}

/**
 * A tenant's numbers, newest first. Released ones only on request (they stay for call history).
 * @param {string} tenantId
 * @param {{includeReleased?: boolean, agentId?: string}} [filter]
 */
export async function listNumbers(tenantId, { includeReleased = false, agentId } = {}) {
  if (!tenantId) throw new Error("listNumbers requires a tenantId");
  return prisma.phoneNumber.findMany({
    where: { tenantId, ...(includeReleased ? {} : { status: "active" }), ...(agentId ? { agentId } : {}) },
    orderBy: { createdAt: "desc" },
    select: SELECT,
  });
}

/** @returns {Promise<object|null>} null for an id that is another tenant's */
export async function getNumber(tenantId, id) {
  return prisma.phoneNumber.findFirst({ where: { tenantId, id }, select: SELECT });
}

/**
 * Add a number to a tenant (what buying one, or registering the hidden forwarding number, will do).
 *
 * @param {string} tenantId
 * @param {{e164: string, label?: string, agentId?: string|null, kind?: "purchased"|"forwarding"}} input
 */
export async function addNumber(tenantId, input = {}) {
  if (!tenantId) throw new Error("addNumber requires a tenantId");
  const e164 = readNumber(input.e164);
  const label = cleanLabel(input.label);
  const kind = input.kind === undefined ? "purchased" : input.kind;
  if (!NUMBER_KINDS.includes(kind)) throw new NumberRuleError("kindInvalid");
  const agentId = await checkAgent(tenantId, input.agentId);

  const active = await prisma.phoneNumber.count({ where: { tenantId, status: "active" } });
  if (active >= MAX_NUMBERS_PER_TENANT) throw new NumberRuleError("tooMany", 409, { max: MAX_NUMBERS_PER_TENANT });

  try {
    const row = await prisma.phoneNumber.create({
      data: { tenantId, e164, activeE164: e164, label, kind, agentId },
      select: SELECT,
    });
    forgetRoute(e164);
    return row;
  } catch (err) {
    // The unique active_e164 is the real guard: two businesses adding the same number at once
    // cannot both win.
    if (isUniqueViolation(err)) throw new NumberRuleError("numberTaken", 409, { number: e164 });
    throw err;
  }
}

/**
 * Re-link a number to another agent (or unlink it with agentId null), or rename it. Takes effect
 * for the next caller: the cached route is dropped.
 *
 * @param {string} tenantId
 * @param {string} id
 * @param {{agentId?: string|null, label?: string}} change
 */
export async function updateNumber(tenantId, id, change = {}) {
  const current = await prisma.phoneNumber.findFirst({ where: { tenantId, id } });
  if (!current) throw new NumberRuleError("notFound", 404);
  if (current.status !== "active") throw new NumberRuleError("released", 409);

  const data = {};
  if (change.label !== undefined) data.label = cleanLabel(change.label);
  if (change.agentId !== undefined) data.agentId = await checkAgent(tenantId, change.agentId);
  const row = Object.keys(data).length
    ? await prisma.phoneNumber.update({ where: { id }, data, select: SELECT })
    : await getNumber(tenantId, id);
  forgetRoute(current.e164);
  return row;
}

/**
 * Give a number up. The row stays (calls point at it, and the history must still say which line a
 * call came in on) but stops routing at once, and the number can be added again later.
 */
export async function releaseNumber(tenantId, id) {
  const current = await prisma.phoneNumber.findFirst({ where: { tenantId, id } });
  if (!current) throw new NumberRuleError("notFound", 404);
  if (current.status === "released") return getNumber(tenantId, id);
  const row = await prisma.phoneNumber.update({
    where: { id },
    data: { status: "released", activeE164: null, agentId: null, releasedAt: new Date() },
    select: SELECT,
  });
  forgetRoute(current.e164);
  return row;
}

/** How many ACTIVE numbers ring an agent — an agent cannot be archived while any does. */
export async function countNumbersForAgent(agentId) {
  return prisma.phoneNumber.count({ where: { agentId, status: "active" } });
}

/**
 * THE READ the lookup seam makes (tenant/registry.js resolveDialledNumber): the active row for this
 * number with its agent's status, and whether the number was ever held (released) — nothing else
 * about the tenant, and nothing a caller supplied beyond the number itself.
 *
 * @param {string} e164 already normalised
 * @returns {Promise<{active: object|null, everHeld: boolean}>}
 */
export async function findNumberForRouting(e164) {
  const active = await prisma.phoneNumber.findUnique({
    where: { activeE164: e164 },
    select: { id: true, tenantId: true, agentId: true, agent: { select: { status: true } } },
  });
  if (active) return { active, everHeld: true };
  const released = await prisma.phoneNumber.count({ where: { e164 } });
  return { active: null, everHeld: released > 0 };
}
