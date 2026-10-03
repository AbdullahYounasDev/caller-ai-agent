#!/usr/bin/env node
/**
 * CHAT PROBE — send a few REAL questions through the brain (respond()) and print the replies.
 *
 * Every question is one chat-model call plus one embedding text: this is a SCARCE-QUOTA tool
 * (§8 limitation 3), so it enforces a hard cumulative budget instead of trusting the operator:
 * the number of calls already made is kept in a small file, and the script refuses to start a
 * call that would pass --max-total (default 10). Delete the file to reset it.
 *
 *   node --import ./scripts/alias-register.mjs scripts/chat-probe.mjs \
 *        --tenant=retest-conflict --budget-file=PATH [--max-total=10] [--channel=chat] \
 *        --q="How much is StorePulse Pro?" --q="Quanto costa il piano Pro?"
 *
 * Each question starts a NEW conversation (no history, so no rewrite call is ever spent) and
 * the conversations it created are deleted afterwards, so a probe leaves the tenant as it found it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

process.loadEnvFile(".env");
const argv = process.argv.slice(2);
const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const questions = argv.filter((a) => a.startsWith("--q=")).map((a) => a.slice(4));
const TENANT = arg("tenant");
const BUDGET_FILE = arg("budget-file");
const MAX_TOTAL = Number(arg("max-total") ?? 10);
const CHANNEL = arg("channel") ?? "chat";
if (!TENANT || !BUDGET_FILE || !questions.length) {
  console.error("usage: --tenant=ID --budget-file=PATH --q=QUESTION [--q=…] [--max-total=10]");
  process.exit(2);
}

const used = () => (existsSync(BUDGET_FILE) ? Number(readFileSync(BUDGET_FILE, "utf8")) || 0 : 0);
if (used() + questions.length > MAX_TOTAL) {
  console.error(`REFUSED: ${used()} chat call(s) already used, ${questions.length} more requested, budget is ${MAX_TOTAL}.`);
  process.exit(3);
}

const { prisma } = await import("@/lib/db");
const { respond } = await import("@/lib/agent/respond");
const created = [];
try {
  for (const q of questions) {
    // Counted BEFORE the call: a call that fails still spent quota.
    writeFileSync(BUDGET_FILE, String(used() + 1));
    const conversation = await prisma.conversation.create({ data: { tenantId: TENANT, channel: CHANNEL } });
    created.push(conversation.id);
    console.log(`\n── Q (${used()}/${MAX_TOTAL}): ${q}`);
    try {
      const r = await respond({ tenantId: TENANT, conversationId: conversation.id, channel: CHANNEL, userMessage: q });
      console.log(`   answered by: ${r.model}`);
      console.log(`   sources:     ${JSON.stringify(r.sources)}`);
      console.log(`   REPLY: ${r.reply}`);
    } catch (err) {
      console.log(`   FAILED: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
} finally {
  if (created.length) {
    // messages first: the foreign key is not ON DELETE CASCADE
    await prisma.message.deleteMany({ where: { conversationId: { in: created } } });
    await prisma.conversation.deleteMany({ where: { id: { in: created } } });
  }
  await prisma.$disconnect();
}
console.log(`\n(chat calls used so far: ${used()}/${MAX_TOTAL})`);
