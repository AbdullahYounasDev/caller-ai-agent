import { pick } from "./catalog";
import { choiceOptions, enabledRecordTypes, fieldApplies, recordTypeLabel, typeFields } from "./config";
import { displayValue, digitsAsWords, validateValue, formatDate } from "./validate";
import { confirmationOf, detectStartType, isCancel, isClosing, isSkip, looksLikeQuestion } from "./phrases";
import { heuristicAnswer, volunteeredValue } from "./extract";
import { combineOrderReads, mentionsOrderChange, mergeOrder, readOrder } from "./order";

/**
 * TAKING A REQUEST — THE STATE MACHINE.
 *
 * The model talks; this file decides. A customer who wants an appointment is walked
 * through the fields the business chose, one question at a time; what they say is checked
 * by validate.js; the moment the last required detail is in, the request is SAVED, then read
 * back to the customer — and a correction after that UPDATES the saved row instead of
 * making a new one. (It used to wait for a spoken "yes" before saving; a customer who simply
 * said "thanks" and hung up left nothing behind.) At no point does the model hold the pen
 * (§6.11): it is handed a PLAN for the turn — "ask for the phone number", "it is saved as
 * AP-4K7Q2, read these back, say a team member will confirm" — and words it. So the same customer, the same phone and the same Tuesday at
 * nine produce the same record whatever the model feels like saying.
 *
 *   idle ──(customer asks for something)──▶ collecting ──(last detail in: SAVED)──▶ saved
 *     ▲                                        │                                       │
 *     │                                        │   (customer corrects a detail: the    │
 *     └─── cancelled / closed / withdrawn ◀────┴──── saved row is UPDATED)─────────────┘
 *
 * Everything stateful lives in the DRAFT (one JSON document per conversation, stored by
 * respond.js); everything that touches the outside world is passed in (`deps`), so this
 * file is plain functions and tests/collect-engine.test.mjs runs the whole machine with no
 * database and no model.
 *
 * WHAT IT WILL NOT DO, ON PURPOSE: confirm or book anything. A request is saved as
 * "requested" and a person confirms it (§6.11). The one thing it does take back is the
 * customer's OWN request while it is still "requested": "forget it" withdraws it. Changing or cancelling an EXISTING booking
 * is not a request either (phrases.js MODIFYING_EXISTING): the agent has nothing to look it
 * up in, and says a team member will help.
 */

/** A draft nobody has touched for this long is forgotten: the caller hung up, or wandered off. */
export const DRAFT_TTL_MS = 30 * 60 * 1000;
/** Unusable answers to ONE required question before the agent gives up on it politely. */
export const MAX_RETRIES = 2;
/** Times the SAME required question may go unanswered (side questions, silence, noise) before giving up. */
export const MAX_MISSES = 4;
/** A message at least this long may hold more than the one thing just asked for. */
const LONG_MESSAGE_WORDS = 6;

const words = (text) => String(text ?? "").trim().split(/\s+/).filter(Boolean).length;

/**
 * A fresh draft.
 * @param {{type: string, nowMs: number, id: string}} args
 */
export function newDraft({ type, nowMs, id }) {
  return { v: 1, id, type, stage: "collecting", values: {}, partial: {}, skipped: [], asked: [], asking: null, retries: {}, startedAt: nowMs, updatedAt: nowMs };
}

/** Is a stored draft still usable for this tenant right now? */
export function isLiveDraft(draft, { nowMs, collect }) {
  return Boolean(draft && draft.v === 1 && nowMs - draft.updatedAt <= DRAFT_TTL_MS && enabledRecordTypes(collect).includes(draft.type));
}

const lineOf = (def, draft, ctx) => ({
  id: def.id,
  label: pick(def.label, ctx.language),
  display: displayValue(def, draft.values[def.id], ctx),
  value: draft.values[def.id],
  type: def.type,
});

/**
 * The values collected so far, as labelled lines, in the order the business asks them. A field
 * that no longer applies (the address of an order that became a pickup) is left out.
 */
export function collectedLines(draft, fields, ctx) {
  return fields.filter((f) => draft.values[f.id] !== undefined && fieldApplies(f, draft.values)).map((f) => lineOf(f, draft, ctx));
}

/** One-line description of a request for lists and notifications: "Ahmed · Root canal · Wednesday, 21 October …". */
export function summarise(draft, fields, ctx) {
  const lines = collectedLines(draft, fields, ctx);
  const byId = new Map(lines.map((l) => [l.id, l.display]));
  const parts = [byId.get("name")];
  const detail = ["order_items", "service", "party_size", "reason", "staff", "company"].find((id) => byId.get(id));
  if (detail) parts.push(detail === "party_size" ? `×${byId.get("party_size")}` : byId.get(detail));
  parts.push(byId.get("datetime") ?? byId.get("order_type") ?? byId.get("callback_window"));
  const text = parts.filter(Boolean).join(" · ");
  return text || lines.map((l) => l.display).slice(0, 3).join(" · ");
}

/**
 * Is this message, while a request is open, simply the ANSWER to what the agent just asked
 * (or a "yes"/"thanks" to the read-back) — so searching the business's documents for it
 * would only cost a second and an embedding for nothing? Judged by rules alone, before any
 * model call, and deliberately conservative: it says yes only when the rules positively
 * READ the message as an answer, never merely because a request happens to be open. A
 * question ("do you have parking?"), a long message or anything the rules cannot place
 * still gets its search, so a side question during booking is answered from the documents.
 *
 * @param {object} args
 * @param {object} args.collect
 * @param {{replyLanguage?: string, timezone?: string, hours?: unknown}} args.agent
 * @param {object|null} args.draft   the conversation's stored draft
 * @param {string} args.message
 * @param {number} args.nowMs
 * @returns {boolean}
 */
export function readsAsAnswer({ collect, agent, draft, message, nowMs }) {
  if (!isLiveDraft(draft, { nowMs, collect })) return false;
  const text = String(message ?? "").trim();
  const count = words(text);
  if (!text || count > 16 || /[?؟]/.test(text) || looksLikeQuestion(text)) return false;

  const fields = typeFields(collect, draft.type);
  const ctx = { config: collect, timezone: agent?.timezone || "UTC", hours: agent?.hours ?? null, nowMs, language: agent?.replyLanguage === "ur" ? "ur" : "en" };

  // After the save the agent is checking the details: "yes", "thanks", a correction.
  if (draft.stage === "saved" || draft.stage === "confirming") {
    if (count > 10) return false;
    if (isClosing(text) || confirmationOf(text) != null || isCancel(text, { askingOptional: true })) return true;
    return fields.some((f) => volunteeredValue(f, text, ctx, { filled: draft.values[f.id] !== undefined }) != null);
  }

  const asking = draft.asking ? fields.find((f) => f.id === draft.asking) : null;
  if (!asking) return false;
  // A number said digit by digit ("zero three zero zero …") is a dozen words long and still only an
  // answer; anything else that long may hold a question the documents should see.
  if (count > 10 && asking.type !== "phone") return false;
  if (isCancel(text, { askingOptional: !asking.required })) return true;
  if (!asking.required && isSkip(text)) return true;
  // A day and time ("tomorrow at five") needs the model to read it, but it is short, plain and
  // never a question about the business — the commonest slow turn of a booking.
  if (asking.type === "datetime") return count <= 8;
  return heuristicAnswer(asking, text, ctx) != null;
}

function idlePlan(collect, language, types) {
  return {
    state: "idle",
    language,
    offers: types.map((type) => {
      const first = typeFields(collect, type)[0];
      return { type, label: recordTypeLabel(collect, type, language), firstQuestion: first ? first.question[language] : "" };
    }),
  };
}

/**
 * Advance a conversation's request by one customer message.
 *
 * @param {object} args
 * @param {object} args.collect   the tenant's normalized collect config (config.js)
 * @param {{replyLanguage?: string, timezone?: string, hours?: unknown}} args.agent
 * @param {object|null} args.draft  what the conversation had before this message
 * @param {string} args.message     the customer's latest message
 * @param {Array<{role: string, content: string}>} [args.history]  earlier turns, oldest first
 * @param {number} args.nowMs
 * @param {object} args.deps
 * @param {() => string} args.deps.newId
 * @param {(request: object) => Promise<{values: object, date: string|null, time: string|null}>} [args.deps.extract]
 *   the model-backed extractor (extract.js); omitted = rules only
 * @param {(record: object) => Promise<{id: string, reference: string}>} args.deps.submit
 *   saves a finished request; idempotent on `record.submissionKey`
 * @param {(recordId: string, patch: object) => Promise<{ok: boolean}>} args.deps.update
 *   rewrites the details of a saved request that is still "requested"
 * @param {(recordId: string) => Promise<{ok: boolean}>} args.deps.withdraw
 *   cancels a saved request that is still "requested"
 * @returns {Promise<{draft: object|null, plan: object|null, changed: boolean}>}
 *   `changed` = the stored draft must be rewritten (or cleared when `draft` is null)
 */
export async function advanceCollection({ collect, agent, draft: stored, message, history = [], nowMs, deps }) {
  const language = agent?.replyLanguage === "ur" ? "ur" : "en";
  const types = enabledRecordTypes(collect);
  if (!types.length) return { draft: null, plan: null, changed: stored != null };

  const ctx = { config: collect, timezone: agent?.timezone || "UTC", hours: agent?.hours ?? null, nowMs, language };
  let draft = isLiveDraft(stored, { nowMs, collect }) ? structuredClone(stored) : null;
  const expired = stored != null && draft == null;

  // ── idle → collecting ───────────────────────────────────────────────
  let started = false;
  if (!draft) {
    const type = detectStartType(message, types);
    if (!type) return { draft: null, plan: idlePlan(collect, language, types), changed: expired };
    draft = newDraft({ type, nowMs, id: deps.newId() });
    started = true;
  }

  const fields = typeFields(collect, draft.type);
  const typeLabel = recordTypeLabel(collect, draft.type, language);
  const base = { language, type: draft.type, typeLabel };
  const done = (plan, nextDraft) => ({ draft: nextDraft, plan: { ...base, ...plan }, changed: true });

  // ── saved: the request exists; the customer is checking it ─────────────
  if (draft.stage === "saved") {
    // Only an unmistakable "cancel it" withdraws: a weak "maybe later" after the read-back
    // must never undo a request the customer asked for.
    if (isCancel(message, { askingOptional: true })) {
      const withdrawn = await deps.withdraw(draft.recordId).catch(() => ({ ok: false }));
      return done(withdrawn.ok ? { state: "withdrawn", reference: draft.reference } : { state: "update_failed", reference: draft.reference, lines: collectedLines(draft, fields, ctx) }, withdrawn.ok ? null : touch(draft, nowMs));
    }

    const verdict = confirmationOf(message);
    // At the read-back EVERY field is open to correction, not just the missing ones.
    const update = verdict === "yes" && words(message) <= LONG_MESSAGE_WORDS ? emptyUpdate() : await understand({ fields, targets: fields, draft, message, asking: null, history, ctx, deps, started: false });
    const applied = apply({ draft, fields, update, ctx });

    if (applied.accepted.length) {
      delete draft.correcting;
      const saved = await deps.update(draft.recordId, requestOf(draft, fields, ctx)).catch(() => ({ ok: false }));
      touch(draft, nowMs);
      if (!saved.ok) return done({ state: "update_failed", reference: draft.reference, lines: collectedLines(draft, fields, ctx) }, draft);
      return done({ state: "saved", reference: draft.reference, lines: collectedLines(draft, fields, ctx), corrected: applied.accepted, problem: applied.problems[0] ?? null }, draft);
    }
    if (applied.problems.length) {
      return done({ state: "saved", reference: draft.reference, lines: collectedLines(draft, fields, ctx), corrected: [], problem: applied.problems[0] }, touch(draft, nowMs));
    }
    if (isClosing(message) || (verdict === "yes" && !draft.correcting)) return done({ state: "closed", reference: draft.reference }, null);
    if (verdict === "no") {
      draft.correcting = true;
      return done({ state: "change", lines: collectedLines(draft, fields, ctx), fields: fields.map((f) => ({ id: f.id, label: pick(f.label, language) })) }, touch(draft, nowMs));
    }
    if (draft.correcting) {
      return done({ state: "change", lines: collectedLines(draft, fields, ctx), fields: fields.map((f) => ({ id: f.id, label: pick(f.label, language) })) }, touch(draft, nowMs));
    }
    // A second, different request in the same conversation starts afresh.
    const again = detectStartType(message, types);
    if (again) return advanceCollection({ collect, agent, draft: null, message, history, nowMs, deps });
    // Neither: they asked something else. Answer it, then ask whether the details are right.
    return done({ state: "saved", reference: draft.reference, lines: collectedLines(draft, fields, ctx), corrected: [], reconfirm: true, extractionFailed: update.failed }, touch(draft, nowMs));
  }

  // ── collecting ──────────────────────────────────────────────────────
  const asking = draft.asking ? fields.find((f) => f.id === draft.asking) ?? null : null;
  const askingOptional = Boolean(asking && !asking.required);
  if (!started && isCancel(message, { askingOptional })) {
    if (!draft.recordId) return done({ state: "cancelled" }, null);
    // Already saved (the optional questions are still being asked): "forget it" withdraws the row.
    const withdrawn = await deps.withdraw(draft.recordId).catch(() => ({ ok: false }));
    if (withdrawn.ok) return done({ state: "withdrawn", reference: draft.reference }, null);
    return done({ state: "update_failed", reference: draft.reference, lines: collectedLines(draft, fields, ctx) }, touch(draft, nowMs));
  }

  let update = emptyUpdate();
  if (asking && askingOptional && isSkip(message) && words(message) <= 4) {
    draft.skipped = [...new Set([...draft.skipped, asking.id])];
  } else {
    // After "something is wrong" any field may be the one being corrected.
    update = await understand({ fields, targets: draft.correcting ? fields : undefined, draft, message, asking, history, ctx, deps, started });
  }
  const applied = apply({ draft, fields, update, ctx });
  if (applied.accepted.length) delete draft.correcting;

  // An optional question that was asked and not answered is not asked again.
  if (asking && askingOptional && draft.values[asking.id] === undefined && !draft.skipped.includes(asking.id) && !applied.problems.some((p) => p.field.id === asking.id)) {
    draft.skipped.push(asking.id);
  }

  draft.updatedAt = nowMs;
  const problem = applied.problems[0] ?? null;

  // A required question the customer cannot answer usably, twice running — or that they keep
  // not answering at all — ends the request politely instead of looping forever.
  if (asking?.required && fieldApplies(asking, draft.values) && draft.values[asking.id] === undefined) {
    draft.misses = { ...draft.misses, [asking.id]: (draft.misses?.[asking.id] ?? 0) + 1 };
  }
  const stuckOn = problem && fields.find((f) => f.id === problem.field.id)?.required && (draft.retries[problem.field.id] ?? 0) >= MAX_RETRIES ? problem.field : null;
  const gaveUp = asking?.required && (draft.misses?.[asking.id] ?? 0) >= MAX_MISSES ? { id: asking.id, label: pick(asking.label, language) } : null;
  if (stuckOn || gaveUp) return done({ state: "stuck", field: stuckOn ?? gaveUp }, null);

  // SAVE AS SOON AS EVERY REQUIRED DETAIL IS IN — not after the last optional question and not
  // after a spoken "yes": a caller who hangs up after the time they wanted must leave a
  // request behind. Optional questions still follow, and each answer updates the saved row.
  let saveFailed = false;
  let updateFailed = false;
  // A field that does not apply (the address of a pickup) is not required.
  if (fields.every((f) => !f.required || !fieldApplies(f, draft.values) || draft.values[f.id] !== undefined)) {
    if (!draft.recordId) {
      try {
        const record = await deps.submit(requestOf(draft, fields, ctx));
        draft.recordId = record.id;
        draft.reference = record.reference;
        draft.justSaved = true;
      } catch (err) {
        // Not fatal and not final: the next message tries again under the same submission
        // key, so a retry can never make a second record.
        console.error("[collect] saving a request failed:", err);
        saveFailed = true;
      }
    } else if (applied.accepted.length) {
      const result = await deps.update(draft.recordId, requestOf(draft, fields, ctx)).catch(() => ({ ok: false }));
      updateFailed = !result.ok;
    }
  }
  const saved = draft.recordId ? { reference: draft.reference, recordId: draft.recordId, justSaved: Boolean(draft.justSaved) } : null;
  delete draft.justSaved;

  const next = fields.find((f) => fieldApplies(f, draft.values) && draft.values[f.id] === undefined && !draft.skipped.includes(f.id));
  if (!next && !saveFailed) {
    draft.asking = null;
    draft.stage = "saved";
    return done({ state: "saved", reference: draft.reference, recordId: draft.recordId, lines: collectedLines(draft, fields, ctx), corrected: applied.accepted, problem, updateFailed, justSaved: saved?.justSaved ?? false }, draft);
  }
  if (saveFailed) {
    draft.asking = null;
    return done({ state: "submit_failed", lines: collectedLines(draft, fields, ctx) }, draft);
  }

  draft.asking = next.id;
  if (!next.required && !draft.asked.includes(next.id)) draft.asked.push(next.id);
  return done(
    {
      state: "ask",
      firstAsk: started,
      collected: collectedLines(draft, fields, ctx),
      ask: askFor(next, draft, ctx),
      problem,
      extractionFailed: update.failed,
      saved,
      corrected: draft.recordId ? applied.accepted : [],
      updateFailed,
    },
    draft
  );
}

/** What createRecord / updateRecordDetails are handed for this draft. */
function requestOf(draft, fields, ctx) {
  // Only what applies: the address of an order that became a pickup is not sent to the team.
  const values = Object.fromEntries(
    Object.entries(draft.values).filter(([id]) => {
      const field = fields.find((f) => f.id === id);
      return !field || fieldApplies(field, draft.values);
    })
  );
  return {
    submissionKey: draft.id,
    type: draft.type,
    values,
    lines: collectedLines(draft, fields, ctx),
    summary: summarise(draft, fields, ctx),
    scheduledAt: draft.values.datetime ?? null,
    language: ctx.language,
    startedAt: draft.startedAt,
  };
}

function touch(draft, nowMs) {
  draft.updatedAt = nowMs;
  return draft;
}

function emptyUpdate() {
  return { values: {}, date: null, time: null, failed: false };
}

/** What to ask for `field`: its wording, whether it can be skipped, and any half-answer already held. */
function askFor(field, draft, ctx) {
  const ask = {
    id: field.id,
    type: field.type,
    label: pick(field.label, ctx.language),
    question: field.question[ctx.language],
    required: field.required,
    options: field.type === "choice" ? optionLabels(field, ctx) : undefined,
    // The dishes that can be ordered — for the model to name a few if the caller asks.
    menu: field.type === "items" ? optionLabels(field, ctx).slice(0, 40) : undefined,
  };
  if (field.type === "datetime") {
    const { date, time } = draft.partial ?? {};
    if (date && !time) ask.have = { date: formatDate(date, ctx.language) };
    if (time && !date) ask.have = { time };
  }
  return ask;
}

function optionLabels(field, ctx) {
  return choiceOptions(ctx.config, field).map((o) => pick(o.label, ctx.language));
}

/**
 * Work out what the customer's message gave us. Rules first (free, and they still work
 * when the model provider is down); the model only when the rules left the question just
 * asked unanswered, or the message is long enough to hold several things.
 */
async function understand({ fields, targets, draft, message, asking, history, ctx, deps, started }) {
  const out = emptyUpdate();
  // An order already taken stays open to "add a coke" / "no raita" while the other questions are asked.
  const changingOrder = fields.filter((f) => f.type === "items" && draft.values[f.id] !== undefined && f.id !== asking?.id && mentionsOrderChange(message));
  const missing = targets ?? [...fields.filter((f) => draft.values[f.id] === undefined && !draft.skipped.includes(f.id)), ...changingOrder];
  if (!missing.length) return out;

  if (asking) {
    const answer = heuristicAnswer(asking, message, ctx);
    if (answer != null) out.values[asking.id] = answer;
  }
  for (const f of missing) {
    if (out.values[f.id] !== undefined) continue;
    const volunteered = volunteeredValue(f, message, ctx, { filled: draft.values[f.id] !== undefined });
    if (volunteered) out.values[f.id] = volunteered;
  }

  // An order the rules only half read ("two biryanis and a PIZZA") goes to the extractor too: only
  // it can name a dish that is not on the menu, so the caller can be told.
  const unresolvedAsk = Boolean(asking && (out.values[asking.id] === undefined || (asking.type === "items" && out.values[asking.id]?.unmatched?.length)));
  const mayHoldMore = words(message) >= LONG_MESSAGE_WORDS && missing.some((f) => out.values[f.id] === undefined);
  const startedWithDetail = started && words(message) >= 4;
  if (deps.extract && (unresolvedAsk || mayHoldMore || startedWithDetail)) {
    try {
      const model = await deps.extract({
        fields: missing,
        asking,
        message,
        history,
        nowMs: ctx.nowMs,
        timezone: ctx.timezone,
        hours: ctx.hours,
        language: ctx.language,
        config: ctx.config,
      });
      // The rules' reading of the question just asked is trusted over the model's;
      // everything else the model found is a candidate. For an order both are kept: the rules'
      // dishes, and what only the model heard (a dish not on the menu).
      for (const [id, raw] of Object.entries(model.values)) {
        const field = missing.find((f) => f.id === id);
        if (out.values[id] === undefined) out.values[id] = raw;
        else if (field?.type === "items") out.values[id] = combineOrderReads(out.values[id], raw, choiceOptions(ctx.config, field));
      }
      out.date = model.date;
      out.time = model.time;
    } catch (err) {
      out.failed = true;
      console.warn(`[collect] extraction failed, continuing on rules alone: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  return out;
}

/**
 * Validate what was understood and fold it into the draft. A value that fails validation
 * changes nothing except the retry count.
 *
 * @returns {{accepted: Array, problems: Array<{field: object, reason: string, vars?: object}>}}
 */
function apply({ draft, fields, update, ctx }) {
  const accepted = [];
  const problems = [];
  const byId = new Map(fields.map((f) => [f.id, f]));

  // A half-answer for the date/time field ("tomorrow" with no hour) is kept until the other half arrives.
  draft.partial = draft.partial ?? {};
  const when = byId.get("datetime");
  if (when && draft.values.datetime === undefined) {
    if (update.date) draft.partial.date = update.date;
    if (update.time) draft.partial.time = update.time;
    if (update.values.datetime === undefined && draft.partial.date && draft.partial.time) {
      update.values.datetime = `${draft.partial.date}T${draft.partial.time}`;
    }
  }

  for (const field of fields) {
    const raw = update.values[field.id];
    if (raw === undefined) continue;
    if (field.type === "items") {
      applyOrder({ draft, field, raw, ctx, accepted, problems });
      continue;
    }
    const result = validateValue(field, raw, ctx);
    if (result.ok && draft.values[field.id] === result.value) continue; // said again, not changed
    if (result.ok) {
      draft.values[field.id] = result.value;
      draft.skipped = draft.skipped.filter((id) => id !== field.id);
      delete draft.retries[field.id];
      if (field.id === "datetime") draft.partial = {};
      accepted.push(lineOf(field, draft, ctx));
    } else {
      draft.retries[field.id] = (draft.retries[field.id] ?? 0) + 1;
      if (field.id === "datetime") draft.partial = {};
      problems.push({ field: { id: field.id, label: pick(field.label, ctx.language) }, reason: result.reason, vars: result.vars });
    }
  }
  return { accepted, problems };
}

/**
 * An order's part of `apply`: what this message said is read against the MENU and folded into
 * what was already ordered (order.js). A dish that is not on the menu, or a word that could mean
 * several dishes, is reported — and when the rest of the order is fine it is still kept
 * (`partial`), so the caller is told about the one dish without having to repeat the others.
 */
function applyOrder({ draft, field, raw, ctx, accepted, problems }) {
  const menu = choiceOptions(ctx.config, field);
  const read = readOrder(raw, menu);
  const before = draft.values[field.id];
  const merged = mergeOrder(before ?? [], read);
  const label = pick(field.label, ctx.language);
  const partial = merged.length > 0;
  const notes = [];
  if (read.unknown.length) notes.push({ reason: "not_on_menu", vars: { items: read.unknown.join(", ") } });
  for (const a of read.ambiguous) notes.push({ reason: "ambiguous_item", vars: { said: a.said, options: a.options.join(", ") } });

  const result = validateValue(field, merged, ctx);
  if (!result.ok) {
    // Nothing usable at all (or a quantity out of range): this counts as a failed answer.
    draft.retries[field.id] = (draft.retries[field.id] ?? 0) + 1;
    const first = notes[0] ?? { reason: result.reason, vars: result.vars };
    problems.push({ field: { id: field.id, label }, reason: first.reason, vars: first.vars });
    return;
  }
  for (const note of notes) problems.push({ field: { id: field.id, label }, reason: note.reason, vars: note.vars, partial });
  if (JSON.stringify(before) === JSON.stringify(result.value)) return; // said again, not changed
  draft.values[field.id] = result.value;
  draft.skipped = draft.skipped.filter((id) => id !== field.id);
  delete draft.retries[field.id];
  accepted.push(lineOf(field, draft, ctx));
}

/**
 * How a phone number is spoken digit by digit — for a voice that must not read "03001234567"
 * as a quantity.
 */
export function spokenPhone(display, language) {
  return digitsAsWords(display, language);
}

/**
 * A draft started because the MODEL recognised a request the rules missed (marker.js): the
 * customer's next message is then the answer to the first question the reply already asked.
 *
 * @param {object} args
 * @param {object} args.collect
 * @param {string} args.type
 * @param {number} args.nowMs
 * @param {string} args.id
 * @returns {object|null} null when that type is not switched on
 */
export function draftFromMarker({ collect, type, nowMs, id }) {
  if (!enabledRecordTypes(collect).includes(type)) return null;
  const draft = newDraft({ type, nowMs, id });
  const first = typeFields(collect, type)[0];
  if (first) {
    draft.asking = first.id;
    if (!first.required) draft.asked.push(first.id);
  }
  return draft;
}
