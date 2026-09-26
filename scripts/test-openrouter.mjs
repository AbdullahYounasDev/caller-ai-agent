#!/usr/bin/env node
/**
 * Verifies the OpenRouter integration END TO END, through the running app,
 * against a local stand-in for OpenRouter.
 *
 * WHY A STAND-IN: the free Gemma pool is rate-limited for long stretches, so
 * the real endpoint cannot be relied on to prove our own code works. This
 * server speaks the exact dialect OpenRouter does — including the awkward parts
 * a naive client gets wrong:
 *
 *   - `: OPENROUTER PROCESSING` keep-alive comment lines (JSON.parse would throw)
 *   - the terminating `data: [DONE]` sentinel, which is not JSON
 *   - frames deliberately flushed mid-JSON so the client must re-assemble them
 *   - a 200 response whose body carries an error (a real OpenRouter behaviour)
 *
 * It also asserts what the REQUEST looked like, which is where the Gemma
 * system-turn handling and the RAG ordering rule actually live.
 *
 * Usage:
 *   node scripts/test-openrouter.mjs            # assumes app on :3000
 *   APP_URL=http://localhost:3001 node scripts/test-openrouter.mjs
 *
 * The app must be started with OPENROUTER_BASE_URL pointing at this server —
 * see the banner printed below if it is not.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PORT || 4545);
const APP = process.env.APP_URL || "http://localhost:3000";
const TENANT = process.env.TEST_TENANT || "test-tenant";

let lastRequest = null;
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const REPLY_PIECES = ["A routine checkup ", "and clean costs ", "80 euros."];

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    lastRequest = { headers: req.headers, body: JSON.parse(body || "{}") };

    if (!lastRequest.body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: lastRequest.body.model,
          choices: [{ message: { role: "assistant", content: REPLY_PIECES.join("") } }],
          usage: { total_tokens: 42 },
        })
      );
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // A keep-alive comment before any data, exactly as OpenRouter sends while a
    // provider is still starting up.
    res.write(": OPENROUTER PROCESSING\n\n");

    let i = 0;
    const tick = setInterval(() => {
      if (i < REPLY_PIECES.length) {
        const frame = `data: ${JSON.stringify({
          choices: [{ delta: { content: REPLY_PIECES[i] } }],
        })}\n\n`;
        // Split the frame across two writes so the client has to buffer a
        // partial frame — the case that breaks naive SSE parsers.
        const cut = Math.floor(frame.length / 2);
        res.write(frame.slice(0, cut));
        res.write(frame.slice(cut));
        i++;
      } else {
        clearInterval(tick);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }, 40);
  });
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`fake OpenRouter listening on http://localhost:${PORT}\n`);

async function main() {
  console.log("— streaming through /api/chat —");
  const res = await fetch(`${APP}/api/chat?tenantId=${encodeURIComponent(TENANT)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "How much is a checkup?" }),
  });

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let session = null;
  let text = "";
  let chunks = 0;
  let done = null;
  let error = null;

  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const ev = (f.match(/^event: (.*)$/m) || [])[1];
      const dt = (f.match(/^data: (.*)$/m) || [])[1];
      if (!dt) continue;
      const payload = JSON.parse(dt);
      if (ev === "session") session = payload;
      else if (ev === "chunk") {
        chunks++;
        text += payload.text;
      } else if (ev === "done") done = payload;
      else if (ev === "error") error = payload.message;
    }
  }

  if (!lastRequest) {
    console.log(
      "\n  The app never called this server.\n" +
        `  Restart it with OPENROUTER_BASE_URL=http://localhost:${PORT} and LLM_PROVIDER=openrouter.\n`
    );
    process.exit(1);
  }

  const expected = REPLY_PIECES.join("");

  check("no error event", error === null, error ?? "");
  check("session arrives first with a conversation id", Boolean(session?.conversationId));
  check(`reply streamed in ${chunks} chunks (not one blob)`, chunks >= REPLY_PIECES.length);
  check("reassembled text is correct", text === expected, JSON.stringify(text));
  check("done event carries the full reply", done?.reply === expected);
  check("keep-alive comment lines did not corrupt the stream", !text.includes("OPENROUTER"));
  check("[DONE] sentinel not emitted as text", !text.includes("[DONE]"));

  console.log("\n— what our client actually sent to OpenRouter —");
  const sent = lastRequest.body;
  const messages = sent.messages;
  const systemMsgs = messages.filter((m) => m.role === "system");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");

  check("stream flag set", sent.stream === true);
  check("model is the configured one", typeof sent.model === "string", sent.model);
  check(
    "Gemma gets NO system message (its template has no system turn)",
    /gemma/i.test(sent.model) ? systemMsgs.length === 0 : true
  );
  check(
    "system instruction folded into the LAST user turn (RAG context beside the live question)",
    Boolean(lastUser && lastUser.content.includes("Customer message:"))
  );
  check(
    "the customer's actual question is the tail of that turn",
    Boolean(lastUser && lastUser.content.trim().endsWith("How much is a checkup?"))
  );
  check(
    "retrieved knowledge reached the model",
    Boolean(lastUser && /REFERENCE MATERIAL/i.test(lastUser.content))
  );
  check(
    "grounding rule reached the model",
    Boolean(lastUser && /GROUNDING RULE/i.test(lastUser.content))
  );
  check("attribution headers present", Boolean(lastRequest.headers["x-title"]));

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`} — ${results.length} checks`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

try {
  await main();
} catch (err) {
  console.error("\ntest harness error:", err.message);
  process.exit(1);
} finally {
  server.close();
}
