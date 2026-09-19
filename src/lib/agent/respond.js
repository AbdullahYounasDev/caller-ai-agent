import { prisma } from "@/lib/db";
import { getAgentConfig } from "@/lib/tenant/config";
import { retrieveRelevantChunks } from "./retrieve";
import { buildSystemInstruction } from "./prompt";
import { generateReply } from "./gemini";

const MAX_HISTORY_MESSAGES = 20;
const MAX_CONTEXT_CHUNKS = 5;

/**
 * The channel-agnostic "brain". Every channel adapter (widget route today,
 * WhatsApp/voice webhooks later) calls this same function with the same
 * shape — it doesn't know or care which channel it's being called from.
 * That's what keeps policy, knowledge and history in one place instead of
 * drifting per channel.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.conversationId
 * @param {string} args.channel - "widget" | "whatsapp" | "voice"
 * @param {string} args.userMessage
 * @param {string} [args.locale] - overrides the conversation's stored locale
 */
export async function respond({ tenantId, conversationId, channel, userMessage, locale }) {
  // 1. Persist the incoming message. Same `messages` table regardless of
  // channel, keyed by conversationId — this is what makes "started on
  // WhatsApp, continued by voice" work later: one query, full history.
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

  // 4. Resolve the reply language: explicit argument (the end user just switched)
  // beats the conversation's stored locale, which beats the tenant's default.
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { locale: true },
  });
  const effectiveLocale =
    locale ?? conversation?.locale ?? config.defaultLocale;

  // Keep the conversation row in step, so later turns and the transcript the
  // business reads both agree on what language this exchange was in.
  if (conversation && conversation.locale !== effectiveLocale) {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { locale: effectiveLocale },
    });
  }

  // 5. Turn configuration into behavior. All prompt text lives in prompt.js.
  const systemInstruction = buildSystemInstruction({
    config,
    channel,
    locale: effectiveLocale,
    chunks,
  });

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
  const assistantReply = await generateReply({ systemInstruction, history });

  // 8. Persist the reply.
  await prisma.message.create({
    data: { conversationId, tenantId, channel, role: "assistant", content: assistantReply },
  });

  return { reply: assistantReply, locale: effectiveLocale };
}
