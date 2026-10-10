#!/usr/bin/env node
/**
 * HOW OFTEN DOES THE CHEAP "needs context" TRIGGER SPEND A REWRITE CALL — and on what?
 *
 * Pure regex over scripts/eval-questions.mjs. No database, no embedding, no model:
 * `npm run eval:trigger` costs nothing and runs in milliseconds.
 *
 * Labels (from the question set itself):
 *   follow-up    category "followup" (16): genuinely needs the conversation. POSITIVE.
 *   standalone   every question WITHOUT a history (71): complete on its own. NEGATIVE —
 *                a rewrite on these is a wasted call (~1-1.5s, §6.19).
 *   new topic    category "followup_offtopic" (7): asked mid-conversation but unrelated.
 *                Reported separately: the rewrite returns these unchanged, so a firing is
 *                a wasted call, but no heuristic on the text alone can tell "what about
 *                the weather?" from "what about Sundays?".
 *
 * precision = fired-on-follow-ups / fired-on-(follow-ups + standalone)
 * recall    = fired-on-follow-ups / follow-ups
 * A follow-up the trigger misses is NOT lost: retrieveForTurn's empty-first-pass net
 * rewrites it when the raw search returns nothing. A miss costs accuracy only when the
 * raw search returns SOMETHING wrong, which is why recall is protected over precision.
 *
 * `LEGACY` below is a frozen copy of the trigger before it was tightened, kept so this
 * script can print the before/after on its own. It is not used by the app.
 *
 * CAVEAT: the rules were tightened against THESE 94 questions. The set is small and the
 * improvement should be read as "the rules are principled and fit it", not as a measured
 * rate on live traffic — re-run this after adding questions.
 */
import { QUESTIONS } from "./eval-questions.mjs";
import { needsContext } from "@/lib/agent/query";
import { isAcknowledgement } from "@/lib/agent/query";

const LEGACY_OPENER = /^\s*(and|but|also|or|so|then|what about|how about|what if|e|ma|anche|invece|oppure|e se|allora|che dire)\b/i;
const LEGACY_ANAPHORA =
  /\b(it|its|that|this|those|these|them|they|there|that one|this one|the \w+ one|the (same|other|first|second|third|last|previous) one|quello|quella|quelli|quelle|questo|questa|lo stesso|la stessa)\b/i;
const legacy = (message) => {
  const text = String(message ?? "").trim();
  if (!text || isAcknowledgement(text)) return false;
  return text.split(/\s+/).filter(Boolean).length <= 4 || LEGACY_OPENER.test(text) || LEGACY_ANAPHORA.test(text);
};

const followUps = QUESTIONS.filter((q) => q.category === "followup");
const standalone = QUESTIONS.filter((q) => !q.history);
const newTopic = QUESTIONS.filter((q) => q.category === "followup_offtopic");

const row = (name, fire) => {
  const tp = followUps.filter((q) => fire(q.q));
  const fp = standalone.filter((q) => fire(q.q));
  const nt = newTopic.filter((q) => fire(q.q));
  return { name, tp, fp, nt, precision: tp.length / (tp.length + fp.length || 1), recall: tp.length / followUps.length, missed: followUps.filter((q) => !fire(q.q)) };
};
const results = [row("legacy (before)", legacy), row("current", needsContext)];

const pct = (x) => `${(100 * x).toFixed(0)}%`.padStart(4);
console.log(`\nTRIGGER eval — ${followUps.length} follow-ups, ${standalone.length} standalone, ${newTopic.length} new-topic-mid-conversation. Regex only: no model, no quota.\n`);
console.log("                    fires on follow-ups   fires on standalone   fires on new-topic   precision  recall");
for (const r of results) {
  console.log(
    `${r.name.padEnd(18)}  ${`${r.tp.length}/${followUps.length}`.padEnd(20)}  ${`${r.fp.length}/${standalone.length}`.padEnd(20)}  ${`${r.nt.length}/${newTopic.length}`.padEnd(18)}  ${pct(r.precision)}      ${pct(r.recall)}`
  );
}
const cur = results[1];
const old = results[0];
console.log("\nStandalone questions the OLD trigger fired on:");
for (const q of old.fp) console.log(`  ${cur.fp.includes(q) ? "STILL " : "fixed "} ${q.q}`);
console.log("\nFollow-ups the current trigger does not fire on (rescued only by the empty-first-pass net):");
for (const q of cur.missed) console.log(`  ${q.q}`);
console.log("\nNew-topic turns that still fire (the rewrite returns them unchanged — a wasted call, not a wrong answer):");
for (const q of cur.nt) console.log(`  ${q.q}`);
