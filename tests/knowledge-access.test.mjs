import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeAgentList, canAgentUse, agentAccessSql, MAX_AGENTS_PER_DOCUMENT } from "@/lib/agent/knowledge-access";
import { retrieveForTurn } from "@/lib/agent/query";

// Which agent may answer from which document (CLAUDE.md §6.28). The SQL is exercised against a
// real database by `npm run test:agents`; here: the rule, the input it accepts, and that the
// filter's shape cannot drift into "no agent = everything".

describe("what a request may say about a document's agents", () => {
  test("omitted = leave as it is; null or \"all\" = shared; a list = only those", () => {
    assert.deepEqual(normalizeAgentList(undefined), { ok: true, agentIds: undefined });
    assert.deepEqual(normalizeAgentList(null), { ok: true, agentIds: null });
    assert.deepEqual(normalizeAgentList("all"), { ok: true, agentIds: null });
    assert.deepEqual(normalizeAgentList(["a-1", "b-2"]), { ok: true, agentIds: ["a-1", "b-2"] });
  });

  test("duplicates collapse; an empty list is refused, never read as nobody or everybody", () => {
    assert.deepEqual(normalizeAgentList(["a-1", "a-1"]).agentIds, ["a-1"]);
    assert.deepEqual(normalizeAgentList([]), { ok: false, code: "agentsEmpty" });
  });

  test("junk is refused: not a list, not ids, too many", () => {
    for (const bad of ["some", 7, {}, [""], ["../x"], [42], [null]]) {
      assert.equal(normalizeAgentList(bad).code, "agentsInvalid", JSON.stringify(bad));
    }
    const many = Array.from({ length: MAX_AGENTS_PER_DOCUMENT + 1 }, (_, i) => `agent-${i}`);
    assert.equal(normalizeAgentList(many).code, "agentsTooMany");
  });
});

describe("the rule: may this agent use this document?", () => {
  test("a shared document (no links) is used by every agent, and by a tenant with no agent row yet", () => {
    assert.equal(canAgentUse(null, "dublin"), true);
    assert.equal(canAgentUse([], "dublin"), true);
    assert.equal(canAgentUse(null, null), true);
  });

  test("a restricted document is used ONLY by the agents it names", () => {
    assert.equal(canAgentUse(["dublin"], "dublin"), true);
    assert.equal(canAgentUse(["dublin", "cork"], "cork"), true);
    assert.equal(canAgentUse(["dublin"], "london"), false);
  });

  test("fails closed: no agent named never reaches a restricted document", () => {
    assert.equal(canAgentUse(["dublin"], null), false);
    assert.equal(canAgentUse(["dublin"], undefined), false);
  });
});

describe("the retrieval filter (SQL shape)", () => {
  const text = (fragment) => fragment.sql ?? fragment.strings?.join("?") ?? "";

  test("no agent → shared documents only; never an empty filter", () => {
    const sql = text(agentAccessSql(null));
    assert.match(sql, /NOT EXISTS/);
    assert.doesNotMatch(sql, /agent_id =/);
    assert.equal(text(agentAccessSql(undefined)), sql, "undefined is the same as null — fail closed");
  });

  test("an agent → shared OR linked to it, with the id as a bound value, never spliced into the text", () => {
    const fragment = agentAccessSql("dublin-1");
    assert.match(text(fragment), /NOT EXISTS[\s\S]*OR EXISTS[\s\S]*agent_id =/);
    assert.doesNotMatch(text(fragment), /dublin-1/);
    assert.ok(fragment.values.includes("dublin-1"));
  });

  test("only an explicit wholeLibrary drops the filter (debug and eval paths)", () => {
    assert.equal(text(agentAccessSql("dublin-1", { wholeLibrary: true })), "");
    assert.notEqual(text(agentAccessSql(null)), "");
  });
});

describe("every search of a turn is limited to the agent answering", () => {
  const history = [
    { role: "user", content: "How much is the Starter plan?" },
    { role: "assistant", content: "89 euros a month." },
  ];

  test("first message, a follow-up that is rewritten, and the empty-first-pass retry all carry the agent", async () => {
    // Long enough not to trigger the cheap follow-up rule, so it is searched raw first, finds
    // nothing, and is then rewritten and searched again.
    const EMPTY = "Is there parking for customers near the main entrance of the building";
    const seen = [];
    const retrieve = async ({ agentId, wholeLibrary, query }) => {
      seen.push({ agentId, wholeLibrary, query });
      return query === EMPTY ? [] : [{ id: "c" }];
    };
    const rewrite = async ({ message }) => ({ query: `standalone ${message}`, status: "rewritten", ms: 0 });

    await retrieveForTurn({ tenantId: "t", agentId: "dublin", message: "What are your hours?", history: [], deps: { retrieve, rewrite } });
    await retrieveForTurn({ tenantId: "t", agentId: "dublin", message: "and the Pro one?", history, deps: { retrieve, rewrite } });
    await retrieveForTurn({ tenantId: "t", agentId: "dublin", message: EMPTY, history, deps: { retrieve, rewrite } });

    assert.ok(seen.length >= 4, "the retry searched twice");
    for (const call of seen) {
      assert.equal(call.agentId, "dublin", `"${call.query}" searched for the agent`);
      assert.equal(call.wholeLibrary, false);
    }
  });

  test("a caller that names no agent searches as 'no agent' (shared only), not the whole library", async () => {
    const seen = [];
    await retrieveForTurn({ tenantId: "t", message: "hours?", history: [], deps: { retrieve: async (a) => (seen.push(a), []) } });
    assert.equal(seen[0].agentId, null);
    assert.equal(seen[0].wholeLibrary, false);
  });
});
