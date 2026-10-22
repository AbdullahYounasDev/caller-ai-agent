/**
 * Several agents per tenant (CLAUDE.md §6.27), end to end against the REAL database and the
 * REAL respond() — with only the model faked (the same stub as test:collect), so it costs no
 * quota.
 *
 *   npm run test:agents        (needs DATABASE_URL, migrations applied)
 *
 * Covers what the unit tests cannot, because it needs Postgres:
 *   - a tenant with nothing saved gets ONE default agent, created on first list or save
 *   - a new agent starts as a copy of another's settings; afterwards each keeps its own
 *   - names: required, unique among active agents, length-capped
 *   - the dashboard language is the TENANT's: saved through any agent, read by every agent
 *   - respond() answers with the agent it is given, and refuses a conversation of another agent
 *   - requests (records) and lists are stamped and filtered by agent; rows from before agents
 *     existed belong to the default agent
 *   - the default can move; the default cannot be archived; an archived agent cannot be default
 *   - tenant isolation: one tenant's agent id is "not found" for another
 *   - the engine's own cap on active agents
 */
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env: DATABASE_URL must come from the environment
  }
}
const { prisma } = await import("@/lib/db");
const stub = await import("./test-collect-stub.mjs");
const { respond } = await import("@/lib/agent/respond");
const config = await import("@/lib/tenant/config");
const { getAgentConfig, saveAgentConfig, saveCollectConfig, listAgents, createAgent, updateAgent, invalidateAgentConfig, MAX_AGENTS_PER_TENANT } = config;
const { presetConfig } = await import("@/lib/collect/config");
const { createRecord, listRecords } = await import("@/lib/standins/records");
const { agentScope } = await import("@/lib/tenant/agent-request");

const T = "__agents_test_chain__";
const OTHER = "__agents_test_other__";
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
  for (const tenantId of [T, OTHER]) {
    await prisma.record.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.message.deleteMany({ where: { tenantId } });
    await prisma.conversation.deleteMany({ where: { tenantId } });
    await prisma.agentConfig.deleteMany({ where: { tenantId } });
    invalidateAgentConfig(tenantId);
  }
}
await wipe();

// ── a tenant with nothing saved ─────────────────────────────────────────────
const before = await getAgentConfig(T, { skipCache: true });
ok(before.exists === false && before.agentId === null && before.isDefault === true, "no row yet: built-in defaults, no agent id, nothing created by a read");
ok((await prisma.agentConfig.count({ where: { tenantId: T } })) === 0, "reading config creates nothing");

const first = await listAgents(T);
ok(first.length === 1 && first[0].isDefault && first[0].id === null, "the agent list is never empty: an unsaved default agent is listed (id null)…");
ok((await prisma.agentConfig.count({ where: { tenantId: T } })) === 0, "…and listing writes nothing");

await saveAgentConfig(T, { businessName: "Pizza Roma", purpose: "An Italian restaurant.", timezone: "Europe/Dublin", replyLanguage: "en" });
const main = await getAgentConfig(T, { skipCache: true });
const mainId = main.agentId;
ok(mainId && main.businessName === "Pizza Roma" && main.isDefault, "the first save that names no agent creates the default agent");
const listed = await listAgents(T);
ok(listed.length === 1 && listed[0].id === mainId, "after it, the list shows the real default agent, once");

// ── a second agent ──────────────────────────────────────────────────────────
ok(await rejects(() => createAgent(T, { name: "  " }), "nameRequired"), "a new agent needs a name");
ok(await rejects(() => createAgent(T, { name: "x".repeat(61) }), "nameTooLong"), "names are length-capped");
const dublin = await createAgent(T, { name: "Dublin branch" });
ok(dublin.id !== mainId && !dublin.isDefault && dublin.name === "Dublin branch", "a second agent is created, not default");
ok(await rejects(() => createAgent(T, { name: "dublin BRANCH" }), "nameTaken"), "two active agents cannot share a name (case-insensitive)");

const dublinCfg = await getAgentConfig(T, { agentId: dublin.id, skipCache: true });
ok(dublinCfg.businessName === "Pizza Roma" && dublinCfg.timezone === "Europe/Dublin", "a new agent starts as a copy of the default's settings");

await saveAgentConfig(T, { businessName: "Pizza Roma Dublin", hours: { mon: [["12:00", "22:00"]] } }, { agentId: dublin.id });
ok((await getAgentConfig(T, { agentId: dublin.id, skipCache: true })).businessName === "Pizza Roma Dublin", "an agent's own settings save");
ok((await getAgentConfig(T, { skipCache: true })).businessName === "Pizza Roma", "…without touching the other agent");

await saveCollectConfig(T, { ...presetConfig("restaurant"), enabled: true }, { agentId: dublin.id });
const dublinCollect = await getAgentConfig(T, { agentId: dublin.id, skipCache: true });
const mainCollect = await getAgentConfig(T, { skipCache: true });
ok(dublinCollect.collect.industry === "restaurant" && dublinCollect.collectVersion === 1
  && mainCollect.collect.industry !== "restaurant" && mainCollect.collectVersion === 0, "what an agent collects is per agent, and versioned per agent");

// The dashboard language belongs to the tenant.
await saveAgentConfig(T, { uiLocale: "ur" }, { agentId: dublin.id });
ok((await getAgentConfig(T, { skipCache: true })).uiLocale === "ur", "a uiLocale saved through another agent lands on the tenant (default agent)");
ok((await getAgentConfig(T, { agentId: dublin.id, skipCache: true })).uiLocale === "ur", "…and every agent reports it");
await saveAgentConfig(T, { uiLocale: "en" });

// ── respond() answers as the agent it is given ───────────────────────────────
const conv = await prisma.conversation.create({ data: { tenantId: T, agentId: dublin.id, channel: "chat" } });
stub.state.instructions.length = 0;
await respond({ tenantId: T, agentId: dublin.id, conversationId: conv.id, channel: "chat", userMessage: "Hello" });
const instruction = stub.state.instructions.at(-1) ?? "";
ok(instruction.includes("Pizza Roma Dublin"), "respond() builds the prompt from the named agent's settings");

let refused = false;
try {
  await respond({ tenantId: T, agentId: mainId, conversationId: conv.id, channel: "chat", userMessage: "Hello again" });
} catch (err) {
  refused = /belongs to agent/.test(err.message);
}
ok(refused, "a conversation held with one agent is never answered by another");

// A conversation from before agents existed (agent_id NULL) is the default agent's.
const legacy = await prisma.conversation.create({ data: { tenantId: T, channel: "chat" } });
let legacyOk = true;
try {
  await respond({ tenantId: T, agentId: mainId, conversationId: legacy.id, channel: "chat", userMessage: "Hi" });
} catch {
  legacyOk = false;
}
ok(legacyOk, "a conversation with no agent (older rows) is answered by the default agent");

// ── requests and lists by agent ──────────────────────────────────────────────
const base = { type: "callback", values: { name: "Aoife", phone: "+353871234567" }, summary: "Aoife", scheduledAt: null, language: "en", channel: "chat" };
await createRecord(T, { ...base, submissionKey: "k-dublin", agentId: dublin.id });
await createRecord(T, { ...base, submissionKey: "k-main", agentId: mainId });
await createRecord(T, { ...base, submissionKey: "k-legacy", agentId: null });
const all = await listRecords(T);
const onlyDublin = await listRecords(T, { agentId: dublin.id });
const onlyMain = await listRecords(T, { agentId: mainId, includeUnassigned: true });
ok(all.total === 3, "without an agent, the list is the whole tenant's");
ok(onlyDublin.total === 1 && onlyDublin.data[0].agentId === dublin.id && onlyDublin.counts.requested === 1, "a request is stamped with the agent that took it, and the list and its counts filter by agent");
ok(onlyMain.total === 2, "the default agent's list includes rows from before it had an id");
ok(JSON.stringify(agentScope(null)) === "{}", "no agent named = no filter");

// ── default and archive rules ────────────────────────────────────────────────
ok(await rejects(() => updateAgent(T, mainId, { status: "archived" }), "archiveDefault"), "the default agent cannot be archived");
ok(await rejects(() => updateAgent(T, dublin.id, { name: "" }), "nameRequired"), "a non-default agent cannot be renamed to nothing");

const moved = await updateAgent(T, dublin.id, { makeDefault: true });
ok(moved.isDefault, "another agent can become the default");
ok((await getAgentConfig(T, { skipCache: true })).agentId === dublin.id, "requests that name no agent now go to it");
ok((await prisma.agentConfig.count({ where: { tenantId: T, defaultFor: T } })) === 1, "exactly one default per tenant");
ok((await listAgents(T))[0].id === dublin.id, "the default is listed first");

const archived = await updateAgent(T, mainId, { status: "archived" });
ok(archived.status === "archived", "the old default can now be archived");
ok((await listAgents(T)).every((a) => a.id !== mainId), "archived agents leave the list…");
ok((await listAgents(T, { includeArchived: true })).some((a) => a.id === mainId), "…but are still there when asked for");
ok((await getAgentConfig(T, { agentId: mainId, skipCache: true })).status === "archived", "an archived agent's settings stay readable");
ok(await rejects(() => updateAgent(T, mainId, { makeDefault: true }), "defaultArchived"), "an archived agent cannot become the default");
const london = await createAgent(T, { name: "London", copyFrom: dublin.id });
ok((await getAgentConfig(T, { agentId: london.id, skipCache: true })).businessName === "Pizza Roma Dublin", "copyFrom copies the named agent");
const restored = await updateAgent(T, mainId, { status: "active" });
ok(restored.status === "active", "an archived agent can be restored");

// ── isolation ────────────────────────────────────────────────────────────────
ok(await rejects(() => getAgentConfig(OTHER, { agentId: dublin.id, skipCache: true }), "AGENT_NOT_FOUND"), "another tenant's agent id is not found");
ok(await rejects(() => saveAgentConfig(OTHER, { businessName: "Hijack" }, { agentId: dublin.id }), "AGENT_NOT_FOUND"), "…and cannot be saved through");
ok(await rejects(() => updateAgent(OTHER, dublin.id, { name: "Hijack" }), "AGENT_NOT_FOUND"), "…or renamed");
ok(await rejects(() => createAgent(OTHER, { name: "Copy", copyFrom: dublin.id }), "AGENT_NOT_FOUND"), "…or copied");
ok((await getAgentConfig(T, { agentId: dublin.id, skipCache: true })).businessName === "Pizza Roma Dublin", "the agent is untouched");

// ── the engine's cap on active agents ───────────────────────────────────────
const active = (await listAgents(T)).length;
for (let i = active; i < MAX_AGENTS_PER_TENANT; i++) await createAgent(T, { name: `Line ${i}` });
ok(await rejects(() => createAgent(T, { name: "One too many" }), "tooMany"), `no more than ${MAX_AGENTS_PER_TENANT} active agents`);

await wipe();
await prisma.$disconnect();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
