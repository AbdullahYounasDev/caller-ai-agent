/**
 * The phone-number lookup (CLAUDE.md §6.29), end to end against the REAL database: the stand-in
 * number store and the seam the engine reads it through, tenant/registry.js resolveDialledNumber().
 * No model and no network, so it costs no quota.
 *
 *   npm run test:numbers        (needs DATABASE_URL, migrations applied)
 *
 * Covers:
 *   - numbers are stored in E.164 whatever the spacing; a number with no country code is refused
 *   - a dialled number → its tenant and its agent; every refusal with its own reason (malformed,
 *     unknown, unlinked, released, archived agent, business not serviceable)
 *   - re-linking a number takes effect for the NEXT caller (the cached route is dropped)
 *   - one active number = one business; a released number can be added again, by anyone
 *   - a number can only ring an ACTIVE agent of its OWN business
 *   - an agent that numbers still ring cannot be archived
 *   - tenant isolation for list / change / release
 *   - a call records the number it came in on, and calls can be listed per number
 */
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env: DATABASE_URL must come from the environment
  }
}
const { prisma } = await import("@/lib/db");
const { saveAgentConfig, createAgent, updateAgent, getAgentConfig, invalidateAgentConfig } = await import("@/lib/tenant/config");
const { resolveDialledNumber } = await import("@/lib/tenant/registry");
const { addNumber, listNumbers, updateNumber, releaseNumber, getNumber } = await import("@/lib/standins/numbers");
const { CallRecorder } = await import("@/lib/voice/recorder");

const A = "__numbers_test_a__";
const B = "__numbers_test_b__";
const BAD = "bad/tenant"; // a tenant id registry.js refuses to serve
let fails = 0;
const ok = (c, m) => {
  console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
  if (!c) fails++;
};
const rejects = async (fn, code) => {
  try {
    await fn();
    return false;
  } catch (err) {
    return err?.code === code;
  }
};

async function wipe() {
  for (const tenantId of [A, B, BAD]) {
    await prisma.callLog.deleteMany({ where: { tenantId } });
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.phoneNumber.deleteMany({ where: { tenantId } });
    await prisma.agentConfig.deleteMany({ where: { tenantId } });
    invalidateAgentConfig(tenantId);
  }
}
await wipe();

// ── a chain with two branches, and another business ─────────────────────────
await saveAgentConfig(A, { businessName: "Pizza Roma" });
const main = (await getAgentConfig(A, { skipCache: true })).agentId;
const dublin = (await createAgent(A, { name: "Dublin" })).id;
const london = (await createAgent(A, { name: "London" })).id;
await saveAgentConfig(B, { businessName: "Other Co" });
const otherAgent = (await getAgentConfig(B, { skipCache: true })).agentId;

// ── adding numbers ──────────────────────────────────────────────────────────
const dub = await addNumber(A, { e164: "+353 1 234 5678", label: "Dublin bookings", agentId: dublin });
ok(dub.e164 === "+35312345678" && dub.agentId === dublin && dub.status === "active", "a number is stored in E.164 whatever the spacing, linked to its agent");
ok(await rejects(() => addNumber(A, { e164: "01 234 5678" }), "needsCountryCode"), "a number without its country code is refused, not guessed");
ok(await rejects(() => addNumber(A, { e164: "call me" }), "numberInvalid"), "junk is refused");
ok(await rejects(() => addNumber(A, { e164: "+44 20 7000 0001", agentId: otherAgent }), "agentNotUsable"), "a number cannot ring another business's agent");
ok(await rejects(() => addNumber(B, { e164: "+353 1 234 5678" }), "numberTaken"), "an active number belongs to ONE business");
const lon = await addNumber(A, { e164: "+44 20 7000 0001", label: "London", agentId: london, kind: "forwarding" });
const spare = await addNumber(A, { e164: "+44 20 7000 0002" });
ok(spare.agentId === null && spare.kind === "purchased", "a number can be added before it is linked");

// ── the lookup ──────────────────────────────────────────────────────────────
const r1 = await resolveDialledNumber("+35312345678");
ok(r1.ok && r1.tenantId === A && r1.agentId === dublin && r1.numberId === dub.id, "a dialled number → its business and ITS agent");
ok((await resolveDialledNumber("00353 1 234 5678")).agentId === dublin, "the same number in another spelling routes the same");
ok((await resolveDialledNumber("+44 20 7000 0001")).agentId === london, "each number rings its own agent");
ok((await resolveDialledNumber("+44 20 7000 0002")).reason === "unassigned", "a number linked to nobody is refused (unassigned), not sent to some agent");
ok((await resolveDialledNumber("+44 20 7999 9999")).reason === "unknown", "a number nobody has → unknown");
ok((await resolveDialledNumber("020 7123 4567")).reason === "invalid_number", "a malformed dialled number → invalid_number");

// Re-link: the next caller reaches the new agent, even though the route was cached a moment ago.
await resolveDialledNumber("+35312345678"); // warm the cache
await updateNumber(A, dub.id, { agentId: london });
ok((await resolveDialledNumber("+35312345678")).agentId === london, "re-linking takes effect for the next caller (the cached route is dropped)");
await updateNumber(A, dub.id, { agentId: dublin, label: "Dublin main" });
ok((await getNumber(A, dub.id)).label === "Dublin main", "a number can be renamed");

// ── an agent that numbers ring ──────────────────────────────────────────────
ok(await rejects(() => updateAgent(A, london, { status: "archived" }), "hasNumbers"), "an agent that a number still rings cannot be archived");
await updateNumber(A, lon.id, { agentId: main });
const archived = await updateAgent(A, london, { status: "archived" });
ok(archived.status === "archived", "once its numbers ring someone else, it can be archived");
ok(await rejects(() => updateNumber(A, lon.id, { agentId: london }), "agentNotUsable"), "a number cannot be linked to an archived agent");
// If an agent ends up archived anyway (a direct change, the backend's own rules), its number refuses.
await prisma.agentConfig.update({ where: { id: dublin }, data: { status: "archived" } });
ok((await resolveDialledNumber("+35312345678", { skipCache: true })).reason === "agent_archived", "a number ringing an archived agent is refused, never re-routed");
await prisma.agentConfig.update({ where: { id: dublin }, data: { status: "active" } });

// ── release, and buying it again ────────────────────────────────────────────
const released = await releaseNumber(A, spare.id);
ok(released.status === "released" && released.agentId === null, "releasing keeps the row (history) and unlinks it");
ok((await resolveDialledNumber("+44 20 7000 0002")).reason === "released", "a released number → released");
ok(await rejects(() => updateNumber(A, spare.id, { label: "x" }), "released"), "a released number cannot be changed");
const rebought = await addNumber(B, { e164: "+44 20 7000 0002", agentId: otherAgent });
ok(rebought.id !== spare.id, "a released number can be added again — by another business");
const r2 = await resolveDialledNumber("+44 20 7000 0002");
ok(r2.ok && r2.tenantId === B && r2.agentId === otherAgent, "…and then rings that business, not the old one");
ok((await listNumbers(A, { includeReleased: true })).some((n) => n.id === spare.id), "the old business still sees its released number in its history");

// ── isolation ───────────────────────────────────────────────────────────────
ok((await listNumbers(B)).every((n) => n.e164 !== "+35312345678"), "one business never lists another's numbers");
ok(await rejects(() => updateNumber(B, dub.id, { agentId: otherAgent }), "notFound"), "…cannot re-link them");
ok(await rejects(() => releaseNumber(B, dub.id), "notFound"), "…nor release them");
ok((await listNumbers(A, { agentId: dublin })).map((n) => n.id).join() === dub.id, "a business can list the numbers of one agent");

// ── a business that may not be served ───────────────────────────────────────
await prisma.phoneNumber.create({ data: { tenantId: BAD, e164: "+44 20 7000 0003".replace(/\s/g, ""), activeE164: "+442070000003" } });
ok((await resolveDialledNumber("+442070000003")).reason !== undefined, "a number of a business that may not be served is refused");
// (It is "unassigned" here — no agent; with an agent it is tenant_unserviceable, checked on EVERY call, never cached.)
await prisma.agentConfig.create({ data: { tenantId: BAD, businessName: "Bad", defaultFor: BAD } }).then((a) =>
  prisma.phoneNumber.updateMany({ where: { tenantId: BAD }, data: { agentId: a.id } })
);
ok((await resolveDialledNumber("+442070000003", { skipCache: true })).reason === "tenant_unserviceable", "with an agent, it is refused as tenant_unserviceable");

// ── calls carry the number they came in on ──────────────────────────────────
const call = await CallRecorder.open({ tenantId: A, agentId: dublin, transport: "browser", engine: {}, toNumber: "+35312345678", phoneNumberId: dub.id });
await call.close?.({ status: "completed", endReason: "caller_hangup", turnCount: 0, interruptions: 0, medianResponseMs: null }).catch(() => {});
const logged = await prisma.callLog.findUnique({ where: { id: call.callId } });
ok(logged.toNumber === "+35312345678" && logged.phoneNumberId === dub.id && logged.agentId === dublin, "a call records its number, its number id and its agent");
ok((await prisma.callLog.count({ where: { tenantId: A, phoneNumberId: dub.id } })) === 1, "calls can be counted per number");

await wipe();
await prisma.$disconnect();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
