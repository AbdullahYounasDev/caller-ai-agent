import { PrismaClient } from "@prisma/client";

// Standard Next.js pattern: in dev, every hot-reload re-imports this module,
// which would spin up a new PrismaClient (and a new pool of DB connections)
// on every save. Stashing the instance on `globalThis` survives the reload.
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
