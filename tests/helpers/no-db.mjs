// Imported FIRST by every test file that pulls in src/ code. Several src modules import
// `@/lib/db` at the top; db.js reuses `globalThis.prisma` when it is set, so planting a
// trap here means (a) no PrismaClient is built and (b) a "pure" test that reaches the
// database fails loudly instead of quietly needing Postgres. jobs.test.mjs replaces it
// with an in-memory fake before importing jobs.js.
globalThis.prisma = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "then") return undefined; // keep `await import()` / promise checks happy
      throw new Error(`a pure test touched the database: prisma.${String(prop)}`);
    },
  }
);
