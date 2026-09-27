import { prisma } from "@/lib/db";
import { getAgentConfig } from "@/lib/tenant/config";
import { retrieveRelevantChunks } from "./retrieve";
import { buildSystemInstruction } from "./prompt";
import { generateReply, generateReplyStream } from "./llm";

const MAX_HISTORY_MESSAGES = 20;
const MAX_CONTEXT_CHUNKS = 5;

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
 */
export async function respond({
  tenantId,
  conversationId,
  channel,
  userMessage,
  onChunk,
}) {
  // 1. Persist the incoming message. Same `messages` table regardless of
  // channel, keyed by conversationId — so a conversation that starts in the
  // test chat and continues by phone is one query with the full history.
  await prisma.message.create({
    data: { conversationId, tenantId, channel, role: "user", content: userMessage },
  });

  // 2. Everything the business configured about its agent — name, purpose,
  // tone, languages, what it's allowed to do, hours. Cached, so this is
  // usually not a DB round trip. Fetched alongside history and retrieval
  // because none of the three depend on each other.
  const [config, priorMessages, chunks] = await Promise.all([
    getAgentConfig(tenantId),
    prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      take: MAX_HISTORY_MESSAGES,
    }),
    // 3. Tenant knowledge relevant to this message — the actual RAG step.
    retrieveRelevantChunks({
      tenantId,
      query: userMessage,
      topK: MAX_CONTEXT_CHUNKS,
    }),
  ]);

  // 4. Record the language this conversation is being held in.
  //
  // This is a TRANSCRIPT RECORD, not an instruction. What the agent replies in
  // is decided by config.replyLanguage inside prompt.js — when that is "auto",
  // the model mirrors the customer and no locale here could know that in
  // advance. We store the business's configured choice so the transcript says
  // something honest, and leave "auto" as "auto".
  const conversationLocale = config.replyLanguage;
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { locale: true },
  });
  if (conversation && conversation.locale !== conversationLocale) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { locale: conversationLocale },
    });
  }

  // 5. Turn configuration into behavior. All prompt text lives in prompt.js.
  const systemInstruction = buildSystemInstruction({ config, channel, chunks });

  // 6. Shape stored history into Gemini's `contents` format.
  const history = priorMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

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
  const assistantReply = onChunk
    ? await generateReplyStream({ systemInstruction, history, onChunk, onProvider })
    : await generateReply({ systemInstruction, history, onProvider });

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
    sources: [...new Set(chunks.map((c) => c.sourceTitle))],
  };
}
