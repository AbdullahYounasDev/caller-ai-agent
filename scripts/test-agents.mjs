/**
 * Several agents per tenant (CLAUDE.md §6.27), end to end against the REAL database and the
 * REAL respond() — with only the model faked (the same stub as test:collect), so it costs no
 * quota.
 *
 *   npm run test:agents        (needs DATABASE_URL, migrations applied)
 *
 * Covers what the unit tests cannot, because it needs Postgres:
 *   - a tenant with nothing saved gets ONE default agent, created on its first save (a list never writes)
 *   - a new agent starts as a copy of another's settings; afterwards each keeps its own
 *   - names: required, unique among active agents, length-capped
 *   - the dashboard language is the TENANT's: saved through any agent, read by every agent
 *   - respond() answers with the agent it is given, and refuses a conversation of another agent
 *   - requests (records) and lists are stamped and filtered by agent; rows from before agents
 *     existed belong to the default agent
 *   - the default can move; the default cannot be archived; an archived agent cannot be default
 *   - tenant isolation: one tenant's agent id is "not found" for another
 *   - the engine's own cap on active agents
 *   - KNOWLEDGE PER AGENT (§6.28): shared vs restricted documents, the retrieval filter for every
 *     kind of caller (an agent, the default, no agent, the debug whole-library path), availability
 *     set at create / kept on replace / swapped with the new chunks / changed without re-embedding,
 *     links removed with the document, a copied agent inheriting nothing restricted, another
 *     tenant's agent refused — and respond() itself answering each agent from its own documents
 *   - EVERY SETTING PER AGENT through the real respond(): call forwarding, what it collects, the
 *     reply language, the opening hours, the call greeting and the recording switch each follow the
 *     agent, not the tenant; a generic opener is searched with the agent's own business name
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
const { buildVoiceGreeting } = await import("@/lib/agent/prompt");
const config = await import("@/lib/tenant/config");
const { getAgentConfig, saveAgentConfig, saveCollectConfig, listAgents, createAgent, updateAgent, invalidateAgentConfig, MAX_AGENTS_PER_TENANT } = config;
const { presetConfig } = await import("@/lib/collect/config");
const { createRecord, listRecords } = await import("@/lib/standins/records");
const { agentScope } = await import("@/lib/tenant/agent-request");
const { ingestDocument, listSources, setDocumentAgents, deleteSource } = await import("@/lib/agent/ingest");
const { retrieveRelevantChunks } = await import("@/lib/agent/retrieve");
const { readAgentsInput, canAgentUse } = await import("@/lib/agent/knowledge-access");

const T = "__agents_test_chain__";
const OTHER = "__agents_test_other__";
const KB = "__agents_test_kb__";
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
  for (const tenantId of [T, OTHER, KB]) {
    await prisma.knowledgeSource.deleteMany({ where: { tenantId } });
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


// Own block: the names below must not collide with the agent tests above.
{
// ── knowledge per agent (§6.28) ─────────────────────────────────────────────
await saveAgentConfig(KB, { businessName: "Pizza Roma", purpose: "An Italian restaurant chain.", timezone: "Europe/Dublin", replyLanguage: "en" });
const kbMain = (await getAgentConfig(KB, { skipCache: true })).agentId;
const kbDublin = (await createAgent(KB, { name: "Dublin" })).id;
const kbLondon = (await createAgent(KB, { name: "London" })).id;

const MENU = "Our menu has pizza margherita, lasagne and tiramisu.";
const DUBLIN = "Dublin branch special: the Guinness stew costs fourteen euros on Fridays.";
const LONDON = "London branch: free parking behind the restaurant after six in the evening.";
const menu = await ingestDocument({ tenantId: KB, title: "menu", text: MENU });
const dubDoc = await ingestDocument({ tenantId: KB, title: "dublin page", text: DUBLIN, agents: [kbDublin] });
const lonDoc = await ingestDocument({ tenantId: KB, title: "london page", text: LONDON, agents: [kbLondon] });

const titlesFor = async (args) =>
  new Set((await retrieveRelevantChunks({ tenantId: KB, query: "anything", topK: 10, maxDistance: 2, ...args })).map((c) => c.sourceTitle));
const same = (set, list) => set.size === list.length && list.every((x) => set.has(x));
ok(same(await titlesFor({ agentId: kbDublin }), ["menu", "dublin page"]), "Dublin answers from the shared menu and its own page — not London's");
ok(same(await titlesFor({ agentId: kbLondon }), ["menu", "london page"]), "London answers from the shared menu and its own page — not Dublin's");
ok(same(await titlesFor({ agentId: kbMain }), ["menu"]), "the default agent sees only what is shared (nothing is restricted to it)");
ok(same(await titlesFor({}), ["menu"]), "no agent named → shared only: the filter fails closed");
ok(same(await titlesFor({ wholeLibrary: true }), ["menu", "dublin page", "london page"]), "only the explicit debug path sees the whole library");

const exact = async (agentId, text) => (await retrieveRelevantChunks({ tenantId: KB, agentId, query: text, topK: 5, maxDistance: 0.0001 })).map((c) => c.sourceTitle);
ok((await exact(kbDublin, DUBLIN)).includes("dublin page"), "the exact question finds Dublin's page for Dublin…");
ok((await exact(kbLondon, DUBLIN)).length === 0, "…and nothing at all for London, even when asked word for word");

const docList = await listSources(KB);
const row = (title) => docList.find((d) => d.title === title);
ok(row("menu").agents === null && JSON.stringify(row("dublin page").agents) === JSON.stringify([kbDublin]), "the document list says who each document is for (null = shared)");
ok(canAgentUse(row("dublin page").agents, kbDublin) && !canAgentUse(row("dublin page").agents, kbLondon) && canAgentUse(row("menu").agents, kbLondon), "the list's per-agent flag is the same rule");

// Replace without saying who it is for: it keeps its availability.
const chunksOf = async (id) => (await prisma.knowledgeChunk.findMany({ where: { sourceId: id }, select: { id: true }, orderBy: { id: "asc" } })).map((c) => c.id).join();
await ingestDocument({ tenantId: KB, title: "dublin page", text: `${DUBLIN} Booking is advised.` });
ok(same(await titlesFor({ agentId: kbLondon }), ["menu", "london page"]), "a replace that does not mention agents keeps the document restricted");
// Replace that changes who it is for: swapped together with the new chunks.
await ingestDocument({ tenantId: KB, title: "dublin page", text: DUBLIN, agents: [kbDublin, kbLondon] });
ok((await titlesFor({ agentId: kbLondon })).has("dublin page"), "a replace that names agents applies them with the new text");

// Change availability alone: no re-embed, the same chunk rows.
const before = await chunksOf(dubDoc.id);
const changed = await setDocumentAgents({ tenantId: KB, id: dubDoc.id, agents: [kbDublin] });
ok(JSON.stringify(changed.agents) === JSON.stringify([kbDublin]) && (await chunksOf(dubDoc.id)) === before, "changing who uses a document re-embeds nothing (same chunk rows)");
ok(!(await titlesFor({ agentId: kbLondon })).has("dublin page"), "…and takes effect on the next search");
await setDocumentAgents({ tenantId: KB, id: dubDoc.id, agents: null });
ok((await titlesFor({ agentId: kbMain })).has("dublin page"), "made shared again → every agent, the default included, uses it");
await setDocumentAgents({ tenantId: KB, id: dubDoc.id, agents: [kbDublin] });

// Input checks a route makes.
ok((await readAgentsInput(KB, [kbDublin])).ok, "an agent of this tenant is accepted");
ok((await readAgentsInput(KB, ["00000000-0000-0000-0000-000000000000"])).code === "agentsUnknown", "a made-up agent id is refused");
const otherAgent = (await listAgents(T, { includeArchived: true }))[0].id;
ok((await readAgentsInput(KB, [otherAgent])).code === "agentsUnknown", "another tenant's agent id is refused — no cross-tenant links");
ok((await readAgentsInput(KB, [])).code === "agentsEmpty", "an empty list is refused, not read as everybody");

// A copy inherits settings, never another agent's restricted documents.
const kbCork = (await createAgent(KB, { name: "Cork", copyFrom: kbDublin })).id;
ok(same(await titlesFor({ agentId: kbCork }), ["menu"]), "a new agent copied from Dublin uses the shared menu, not Dublin's page");

// A document deleted takes its links with it.
await deleteSource({ tenantId: KB, id: lonDoc.id });
ok((await prisma.knowledgeSourceAgent.count({ where: { sourceId: lonDoc.id } })) === 0, "deleting a document removes who it was for");
ok((await prisma.knowledgeSourceAgent.count({ where: { sourceId: menu.id } })) === 0, "a shared document has no links at all");

// respond() itself: each agent answers from its own documents.
const promptFor = async (agentId, message) => {
  const conv = await prisma.conversation.create({ data: { tenantId: KB, agentId, channel: "chat" } });
  stub.state.instructions.length = 0;
  const result = await respond({ tenantId: KB, agentId, conversationId: conv.id, channel: "chat", userMessage: message });
  return { result, instruction: stub.state.instructions.at(-1) ?? "" };
};
const dubTurn = await promptFor(kbDublin, DUBLIN);
const lonTurn = await promptFor(kbLondon, DUBLIN);
ok(dubTurn.instruction.includes("Guinness stew") && dubTurn.result.sources.includes("dublin page"), "respond(): Dublin's agent is given Dublin's page");
ok(!lonTurn.instruction.includes("Guinness stew") && !lonTurn.result.sources.includes("dublin page"), "respond(): London's agent never sees it, asked the very same question");

// ── every setting follows the agent, not the tenant ─────────────────────────
await saveAgentConfig(KB, {
  replyLanguage: "ur",
  hours: { mon: [["12:00", "22:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  escalation: { enabled: true, contacts: [{ id: "c1", role: "Manager", name: "Siobhan", phone: "0300 1234567" }], whenCallerAsks: true, afterMisses: 2, topics: [], outsideHours: "forward" },
}, { agentId: kbDublin });
await saveAgentConfig(KB, { replyLanguage: "en", hours: null }, { agentId: kbLondon });
await saveCollectConfig(KB, { ...presetConfig("restaurant"), enabled: true }, { agentId: kbLondon });

const askPerson = "I want to speak to a person please";
const dubHuman = await promptFor(kbDublin, askPerson);
const lonHuman = await promptFor(kbLondon, askPerson);
ok(dubHuman.result.handoff?.kind === "handoff" && dubHuman.result.handoff.contacts[0].name === "Siobhan", "call forwarding: Dublin passes the caller to ITS person");
ok(!lonHuman.result.handoff, "call forwarding: London (not set up) does not");
ok(/ALWAYS reply in Urdu/.test(dubHuman.instruction) && /ALWAYS reply in English/.test(lonHuman.instruction), "reply language is per agent");
ok(dubHuman.instruction.includes("12:00") && !lonHuman.instruction.includes("12:00"), "opening hours are per agent");
ok(dubHuman.result.collection === null && lonHuman.result.collection !== null, "what the agent collects is per agent (London takes requests, Dublin does not)");
ok((await getAgentConfig(KB, { agentId: kbDublin, skipCache: true })).escalation.contacts.length === 1
  && (await getAgentConfig(KB, { agentId: kbLondon, skipCache: true })).escalation.contacts.length === 0, "forwarding contacts are stored per agent");

// The call greeting and the recording switch (lib/voice/greeting.js) follow the agent too.
await saveAgentConfig(KB, { businessName: "Roma Dublin", greeting: { en: "Welcome to {business}, our AI is here.", ur: "" }, recordCalls: true }, { agentId: kbDublin });
await saveAgentConfig(KB, { businessName: "Roma London", greeting: {}, recordCalls: false }, { agentId: kbLondon });
const dubCfg = await getAgentConfig(KB, { agentId: kbDublin, skipCache: true });
const lonCfg = await getAgentConfig(KB, { agentId: kbLondon, skipCache: true });
ok(dubCfg.recordCalls === true && lonCfg.recordCalls === false, "call recording is switched on per agent");
ok(JSON.stringify(dubCfg.greeting) === JSON.stringify({ en: "Welcome to {business}, our AI is here." }), "the greeting is stored per agent, empty languages dropped");
ok(buildVoiceGreeting({ ...dubCfg, replyLanguage: "en" }).text === "Welcome to Roma Dublin, our AI is here.", "Dublin's call opens with Dublin's own words");
ok(/^Hello, thanks for calling Roma London\. You're speaking with an AI assistant\. How can I help/.test(buildVoiceGreeting(lonCfg).text), "London (no own text) opens with the built-in greeting — AI notice, no recording sentence");
// Dublin answers in Urdu and has no Urdu text of its own: the built-in Urdu greeting, with the recording sentence.
ok(/اے آئی اسسٹنٹ.*کال ریکارڈ کی جا رہی ہے/.test(buildVoiceGreeting(dubCfg).text), "Dublin in Urdu: built-in greeting, saying the call is recorded");
const kbGalway = (await createAgent(KB, { name: "Galway", copyFrom: kbDublin })).id;
const galCfg = await getAgentConfig(KB, { agentId: kbGalway, skipCache: true });
ok(galCfg.recordCalls === true && galCfg.greeting.en === dubCfg.greeting.en, "a new agent copies the greeting and the recording switch of the agent it starts from");
await saveAgentConfig(KB, { greeting: { en: "Galway here." } }, { agentId: kbGalway });
ok((await getAgentConfig(KB, { agentId: kbDublin, skipCache: true })).greeting.en === dubCfg.greeting.en, "…and changing the copy leaves the original alone");

// A generic opener is searched with the agent's OWN business name in front (§6.20).
const opener = await promptFor(kbLondon, "tell me about your company");
ok(opener.result.searchQuery === "Roma London: tell me about your company" && opener.result.searchTrigger === "overview", "an opener is searched as '<this agent's business>: <question>'");
ok(/THIS MESSAGE is a general question about the business/.test(opener.instruction), "…and the prompt is told it is a general question");
}

// ── the engine's cap on active agents ───────────────────────────────────────
const active = (await listAgents(T)).length;
for (let i = active; i < MAX_AGENTS_PER_TENANT; i++) await createAgent(T, { name: `Line ${i}` });
ok(await rejects(() => createAgent(T, { name: "One too many" }), "tooMany"), `no more than ${MAX_AGENTS_PER_TENANT} active agents`);

await wipe();
await prisma.$disconnect();
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
