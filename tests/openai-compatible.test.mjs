import "./helpers/no-db.mjs";
import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/**
 * The OpenAI-compatible provider (openrouter.js, groq.js) against a LOCAL stand-in server —
 * loopback only, no external network, no quota. Pins what the voice channel depends on:
 * reasoning text is never streamed as the answer, keep-alive comments and broken frames
 * do not kill a stream, provider-specific body fields reach the provider, and an error
 * body with HTTP 200 is an error.
 */

let server;
let requests = [];
let mode = "stream";

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      if (mode === "error-body") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "upstream died", code: 502 } }));
      }
      if (!parsed.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: { content: "Plain reply." } }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const frame = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      res.write(": PROCESSING\n\n");
      frame({ choices: [{ delta: { reasoning: "The user asks about hours; check the passage." } }] });
      frame({ choices: [{ delta: { content: "We open " } }] });
      res.write("data: {not json\n\n");
      frame({ choices: [{ delta: { content: "at nine." } }] });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  Object.assign(process.env, {
    OPENROUTER_BASE_URL: base,
    OPENROUTER_API_KEY: "test-or",
    GROQ_BASE_URL: base,
    GROQ_API_KEY: "test-groq",
    GROQ_MODEL: "openai/gpt-oss-120b",
    GROQ_REASONING_EFFORT: "low",
  });
});

after(() => server.close());

const history = [{ role: "user", parts: [{ text: "When do you open?" }] }];

describe("OpenAI-compatible providers", () => {
  test("Groq streaming: only `content` is the answer — reasoning, keep-alives and broken frames are skipped", async () => {
    requests = [];
    mode = "stream";
    const groq = await import("@/lib/agent/groq");
    const chunks = [];
    const full = await groq.generateReplyStream({ systemInstruction: "Be brief.", history, onChunk: (c) => chunks.push(c) });
    assert.equal(full, "We open at nine.");
    assert.deepEqual(chunks, ["We open ", "at nine."]);
    const sent = requests[0];
    assert.equal(sent.url, "/chat/completions");
    assert.equal(sent.headers.authorization, "Bearer test-groq");
    assert.equal(sent.body.model, "openai/gpt-oss-120b");
    assert.equal(sent.body.reasoning_effort, "low", "provider-specific field reaches Groq");
    assert.equal(sent.body.stream, true);
    assert.deepEqual(sent.body.messages[0], { role: "system", content: "Be brief." });
  });

  test("OpenRouter: attribution headers, no Groq-only fields, and a Gemma model gets the system text folded into the LAST user turn", async () => {
    requests = [];
    mode = "plain";
    const openrouter = await import("@/lib/agent/openrouter");
    const reply = await openrouter.generateReply({
      systemInstruction: "SYSTEM RULES",
      history: [
        { role: "user", parts: [{ text: "first" }] },
        { role: "model", parts: [{ text: "answer" }] },
        { role: "user", parts: [{ text: "second" }] },
      ],
      model: "google/gemma-4-31b-it:free",
    });
    assert.equal(reply, "Plain reply.");
    const sent = requests[0];
    assert.equal(sent.headers["x-title"], "Caller AI Agent");
    assert.equal(sent.body.reasoning_effort, undefined);
    assert.equal(sent.body.messages.length, 3);
    assert.equal(sent.body.messages[0].content, "first");
    assert.match(sent.body.messages[2].content, /^SYSTEM RULES\n\n---\n\nCustomer message:\nsecond$/);
  });

  test("a 200 response carrying an error body is an error, with a status the fallback logic can read", async () => {
    mode = "error-body";
    const groq = await import("@/lib/agent/groq");
    await assert.rejects(() => groq.generateReply({ systemInstruction: "", history }), (err) => {
      assert.match(err.message, /upstream died/);
      assert.equal(err.status, 502);
      return true;
    });
  });

  test("llm.js describes and routes the groq provider", async () => {
    process.env.LLM_PROVIDER = "groq";
    process.env.LLM_FALLBACK_PROVIDER = "gemini";
    const { describeChatProvider } = await import("@/lib/agent/llm");
    assert.match(describeChatProvider(), /^groq:openai\/gpt-oss-120b → gemini:/);
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_FALLBACK_PROVIDER;
  });
});
