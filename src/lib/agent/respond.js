import { prisma } from "@/lib/db";
import { getAgentConfig } from "@/lib/tenant/config";
import { retrieveForTurn } from "./query";
import { buildSystemInstruction } from "./prompt";
import { generateReply, generateReplyStream, generateExtraction } from "./llm";
import { randomUUID } from "node:crypto";
import { enabledRecordTypes } from "@/lib/collect/config";
import { advanceCollection, draftFromMarker } from "@/lib/collect/engine";
import { createExtractor } from "@/lib/collect/extract";
import { createMarkerFilter, stripMarker } from "@/lib/collect/marker";
import { writeDraft } from "@/lib/collect/store";
import { createRecord, updateRecordDetails, withdrawRecord } from "@/lib/standins/records";

const MAX_HISTORY_MESSAGES = 20;
const MAX_CONTEXT_CHUNKS = 5;

// One extractor for the whole process (lib/collect/extract.js): it carries no state, and the
// circuit breaker behind generateExtraction is shared on purpose.
const extractDetails = createExtractor({ generate: generateExtraction });

/**
 * The channel-agnostic "brain". Every channel adapter — the test chat today,
 * the telephony webhook later — calls this same function with the same shape.
 * It does not know or care which channel it is being called from, and that is
 * what keeps policy, knowledge and history in one place instead of drifting
 * per channel.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.conversationId
 * @param {string} args.channel - "chat" | "voice"
 * @param {string} args.userMessage
 * @param {(chunk: string) => void} [args.onChunk] - when given, the reply streams
 *        through this callback as it's generated. Everything else is identical:
 *        same config, same retrieval, same prompt, same persistence. Streaming is
 *        a DELIVERY choice, not a different brain — which is why it's a parameter
 *        here rather than a second function that would drift out of step.
 * @param {(stage: "retrieved"|"first_token", data: object) => void} [args.onStage] -
 *        OBSERVATION ONLY: told when retrieval has finished (with what it found) and
 *        when the first token of the reply arrives, so a channel can show and log
 *        progress while the turn is still running — the voice gateway's live timeline
 *        (§6.24). It cannot change anything about the turn, and a throwing callback is
 *        swallowed: reporting on a reply must never break the reply.
 */
export async function respond({
  tenantId,
  conversationId,
  channel,
  userMessage,
  onChunk,
  onStage,
}) {
  const stage = (name, data) => {
    try {
      onStage?.(name, data);
    } catch {
      // Observation must never break the turn it observes.
    }
  };
  const startedAt = performance.now();
  const since = (t) => Math.round(performance.now() - t);
  // 1. Persist the incoming message. Same `messages` table regardless of
  // channel, keyed by conversationId — so a conversation that starts in the
  // test chat and continues by phone is one query with the full history.
  await prisma.message.create({
    data: { conversationId, tenantId, channel, role: "user", content: userMessage },
  });

  // 2. Everything the business configured about its agent — name, purpose,
  // tone, languages, what it's allowed to do, hours. Cached, so this is
  // usually not a DB round trip. Fetched alongside history and the
  // conversation's stored locale (step 4) because none of the three depend on
  // each other — folding the locale read in here too means it costs nothing
  // extra (see §6.17).
  //
  // RETRIEVAL IS NO LONGER IN THIS BLOCK. It used to run alongside these reads
  // because it only needed the raw message. Conversation-aware retrieval needs
  // the history first ("and the Pro one?" cannot be searched without knowing
  // what was being discussed), so it runs right after — one DB round trip
  // earlier than it could have started, which is the price of resolving
  // follow-ups at all (§6.19).
  const [config, recentMessages, conversation] = await Promise.all([
    getAgentConfig(tenantId),
    // MOST RECENT MAX_HISTORY_MESSAGES, not the oldest — see §6.17. `desc` +
    // `.reverse()` below is what turns "most recent N" back into the
    // chronological order the model expects.
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: MAX_HISTORY_MESSAGES,
    }),
    prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { locale: true, collectDraft: true },
    }),
  ]);
  // `desc` fetched the NEWEST N messages, newest first — reversed here so the
  // model still reads the conversation in the order it actually happened.
  // The just-persisted message from step 1 is always the newest of all, so
  // it is always the LAST element after this reverse, never silently outside
  // the window (see §6.17 for what went wrong before this).
  const priorMessages = recentMessages.reverse();

  // 3. Tenant knowledge relevant to this message — the actual RAG step, now
  // resolved against the conversation so a follow-up is searched as the
  // question it really is. `earlierTurns` is everything BEFORE this message:
  // step 1 already persisted it, so it is the last element and must not be
  // shown to the rewrite as if it were history.
  const last = priorMessages[priorMessages.length - 1];
  const earlierTurns =
    last && last.role === "user" && last.content === userMessage
      ? priorMessages.slice(0, -1)
      : priorMessages;
  const contextMs = since(startedAt);
  const retrievalStartedAt = performance.now();
  // Taking a customer's request (an appointment, a callback — lib/collect) runs ALONGSIDE
  // retrieval: it needs the same history and nothing from the search, and retrieval is the
  // slower of the two (an embedding round trip), so it adds no latency to a turn.
  const [turn, collection] = await Promise.all([
    retrieveForTurn({
      tenantId,
      message: userMessage,
      history: earlierTurns,
      topK: MAX_CONTEXT_CHUNKS,
    }),
    takeRequest({ tenantId, conversationId, channel, config, userMessage, earlierTurns, storedDraft: conversation?.collectDraft ?? null }),
  ]);
  const chunks = turn.chunks;
  const retrievalMs = since(retrievalStartedAt);
  const sources = [...new Set(chunks.map((c) => c.sourceTitle))];
  stage("retrieved", {
    sources,
    searchQuery: turn.searchQuery,
    trigger: turn.trigger,
    rewriteStatus: turn.rewrite?.status ?? null,
    rewriteMs: turn.rewrite?.ms ?? null,
    ms: retrievalMs,
  });

  // 4. Record the language this conversation is being held in.
  //
  // This is a TRANSCRIPT RECORD, not an instruction. What the agent replies in
  // is decided by config.replyLanguage inside prompt.js — when that is "auto",
  // the model mirrors the customer and no locale here could know that in
  // advance. We store the business's configured choice so the transcript says
  // something honest, and leave "auto" as "auto".
  const conversationLocale = config.replyLanguage;
  if (conversation && conversation.locale !== conversationLocale) {
    // NOT awaited. This write only matters for a transcript a human might read
    // later — nothing later in this function reads it back — so it must not
    // add a DB round trip to reply latency on the common turn where the
    // locale hasn't changed either (see §6.17). Best-effort, like jobs.js's
    // own progress writes (§6.6): losing this update loses a label, never
    // correctness.
    void prisma.conversation
      .update({ where: { id: conversationId }, data: { locale: conversationLocale } })
      .catch(() => {});
  }

  // 5. Turn configuration into behavior. All prompt text lives in prompt.js.
  const systemInstruction = buildSystemInstruction({ config, channel, chunks, collection: collection.plan });

  // 6. Shape stored history into Gemini's `contents` format.
  let history = priorMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // DROP A LEADING "model" TURN. Once a conversation is longer than
  // MAX_HISTORY_MESSAGES, the window fetched above is a slice into the
  // MIDDLE of it and can start on either role — roughly half the time it
  // starts on an assistant reply, since turns alternate. Verified live
  // against the real Gemini API that a leading "model" turn does not error
  // (the model just answers as if replying to unstated context), but it is
  // a turn with no question attached to it — pure noise, not useful
  // grounding — so it is trimmed rather than kept on the strength of
  // undocumented tolerance. The just-persisted message from step 1 is
  // always the newest turn and always "user" (see priorMessages above), so
  // this can never empty the array — at most one leading turn is trimmed,
  // since strict user/assistant alternation means the turn behind a "model"
  // turn is always "user".
  let start = 0;
  while (start < history.length && history[start].role === "model") start++;
  history = history.slice(start);

  // CONSECUTIVE SAME-ROLE TURNS (e.g. two "user" turns in a row, left behind
  // when a prior reply failed before step 8 ever persisted one — see the
  // catch-free LLM call below) are deliberately left AS TWO TURNS, not
  // merged into one. Verified live against the real Gemini API that this
  // does not error and the model correctly uses context from both turns;
  // OpenAI-style chat APIs (OpenRouter, in openrouter.js's toOpenAiMessages)
  // don't require strict role alternation either. Merging would invent a
  // turn structure that never actually happened in the conversation for a
  // problem that, tested, does not exist.

  // 7. Call the LLM.
  // TODO (Phase 4): tool-calling. The tenant's enabled capabilities already
  // resolve to `toolName`s in capabilities/catalog.js — register those as
  // function declarations here, execute them, and log each executed call to
  // agent_actions. Then flip TOOL_EXECUTION_AVAILABLE in prompt.js.
  // The model never silently mutates tenant data.
  let answeredBy = null;
  const onProvider = (description) => {
    answeredBy = description;
  };
  // Time to the first token is measured on the stream itself, not inferred: it is the
  // stage a voice caller hears as silence (§6.24), so it is the one worth knowing exactly.
  const generationStartedAt = performance.now();
  let firstTokenMs = null;
  // The model may open a reply with a start marker (lib/collect/marker.js); it is held back
  // and removed here, so neither the customer nor the text-to-speech voice ever sees it.
  const markers = createMarkerFilter();
  const passOn = onChunk
    ? (text) => {
        if (!text) return;
        if (firstTokenMs === null) {
          firstTokenMs = since(generationStartedAt);
          stage("first_token", { ms: firstTokenMs });
        }
        onChunk(text);
      }
    : undefined;
  const streamChunk = passOn ? (text) => passOn(markers.push(text)) : undefined;
  let rawReply;
  try {
    rawReply = streamChunk
      ? await generateReplyStream({ systemInstruction, history, onChunk: streamChunk, onProvider })
      : await generateReply({ systemInstruction, history, onProvider });
  } catch (err) {
    // The customer never heard this turn's question or read-back, so the request must not
    // have moved on either: put the draft back as it was. (If the turn had SAVED a request,
    // restoring the draft is still right: the customer's next "yes" saves the same
    // submission key, which returns the same record rather than a second one.)
    if (collection.draftWrite) {
      await collection.draftWrite;
      await writeDraft(conversationId, conversation?.collectDraft ?? null).catch(() => {});
    }
    throw err;
  }
  if (passOn) passOn(markers.end());
  const { text: assistantReply, type: markedType } = stripMarker(rawReply);
  const generationMs = since(generationStartedAt);

  // The model recognised a request the rules missed: start the draft so the NEXT message is
  // taken as the answer to the question this reply just asked.
  if (markedType && collection.plan?.state === "idle") {
    const draft = draftFromMarker({ collect: config.collect, type: markedType, nowMs: Date.now(), id: randomUUID() });
    if (draft) collection.draftWrite = writeDraft(conversationId, draft).catch((err) => console.error("[collect] could not start a draft:", err));
  }
  await collection.draftWrite;

  // 8. Persist the reply.
  await prisma.message.create({
    data: { conversationId, tenantId, channel, role: "assistant", content: assistantReply },
  });

  return {
    reply: assistantReply,
    locale: conversationLocale,
    // DEBUG METADATA, not part of the reply itself — the test chat displays
    // these alongside the bubble so a human can tell what answered and from
    // what, without digging through logs. Voice will simply ignore both:
    // CHANNEL_STYLE.voice never reads structured fields, only `reply`.
    model: answeredBy,
    // Deduplicated, in retrieval order (closest match first) — empty when
    // nothing cleared MAX_DISTANCE, which is itself useful to see: it means
    // this reply came from the persona/instructions alone, not the knowledge
    // base.
    sources,
    // Whether the follow-up step fired ("heuristic" | "empty") or not (null) — §6.19.
    searchTrigger: turn.trigger,
    // Where the turn's time went, in ms. contextMs: config + history reads;
    // retrievalMs: search INCLUDING any follow-up rewrite (rewriteMs is that part);
    // firstTokenMs: generation start → first streamed token (null when not streaming);
    // generationMs: the whole generation. The voice call log stores these per turn.
    timings: {
      contextMs,
      retrievalMs,
      rewriteMs: turn.rewrite?.ms ?? null,
      firstTokenMs,
      generationMs,
    },
    // What was actually SEARCHED when it differs from what the customer said
    // (§6.19) — so "why did it answer about the Pro plan?" is answerable by
    // looking at the bubble instead of the server log. null when the message
    // was searched as typed. `rewriteStatus` is "failed" when the rewrite step
    // errored and the raw message was searched instead (it never fails the
    // reply), so a silent fallback is still visible to a human.
    searchQuery: turn.searchQuery !== userMessage ? turn.searchQuery : null,
    rewriteStatus: turn.rewrite?.status ?? null,
    // What happened to a request this turn, for the console and the call log — null when the
    // business takes none. `field` is the question just asked; `reference` exists once saved.
    collection: collection.plan
      ? {
          state: collection.plan.state,
          type: collection.plan.type ?? markedType ?? null,
          field: collection.plan.ask?.id ?? null,
          reference: collection.plan.reference ?? collection.plan.saved?.reference ?? null,
        }
      : null,
  };
}

/**
 * Move this conversation's request on by one message and persist the draft — failing
 * SOFT: taking a request is a feature on top of answering, and a bug or an outage in it must
 * cost the customer nothing but the request, never the reply.
 *
 * @returns {Promise<{plan: object|null, draftWrite: Promise<void>|null}>}
 */
async function takeRequest({ tenantId, conversationId, channel, config, userMessage, earlierTurns, storedDraft }) {
  if (!enabledRecordTypes(config.collect).length) return { plan: null, draftWrite: null };
  try {
    const result = await advanceCollection({
      collect: config.collect,
      agent: config,
      draft: storedDraft,
      message: userMessage,
      history: earlierTurns,
      nowMs: Date.now(),
      deps: {
        newId: randomUUID,
        extract: extractDetails,
        submit: (record) =>
          createRecord(tenantId, { ...record, conversationId, channel, timezone: config.timezone, configVersion: config.collectVersion }),
        update: (recordId, record) => updateRecordDetails(tenantId, recordId, record),
        withdraw: (recordId) => withdrawRecord(tenantId, recordId),
      },
    });
    // Not awaited here: the write runs while the model generates, and respond() awaits it
    // before returning, so the next message always finds the draft.
    const draftWrite = result.changed
      ? writeDraft(conversationId, result.draft).catch((err) => console.error("[collect] could not save the draft:", err))
      : null;
    return { plan: result.plan, draftWrite };
  } catch (err) {
    console.error("[collect] taking a request failed; replying without it:", err);
    return { plan: null, draftWrite: null };
  }
}
