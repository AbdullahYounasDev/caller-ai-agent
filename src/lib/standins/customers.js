import { prisma } from "@/lib/db";

/**
 * STAND-IN for the backend's `end_customers` (see ./README.md).
 *
 * A customer is found again by phone number, so someone who calls twice is one row. A
 * request with no phone number (an email-only appointment) makes a row of its own — an
 * address is not reliable enough to merge two people on.
 *
 * @param {string} tenantId
 * @param {{name?: string|null, phone?: string|null, email?: string|null}} details
 * @returns {Promise<{id: string}>}
 */
export async function upsertCustomer(tenantId, { name = null, phone = null, email = null }) {
  if (!tenantId) throw new Error("upsertCustomer requires a tenantId");
  if (phone) {
    // The newest details win: a customer who corrects their spelling is corrected once.
    return prisma.customer.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, name, phone, email },
      update: { ...(name ? { name } : {}), ...(email ? { email } : {}) },
      select: { id: true },
    });
  }
  return prisma.customer.create({ data: { tenantId, name, email }, select: { id: true } });
}
