import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Where a conversation's half-finished request lives: one JSON column on the conversation
 * (conversations.collect_draft). Small on purpose — the engine rewrites the whole document
 * each turn, and nothing ever queries inside it.
 */

/** @param {string} conversationId @returns {Promise<object|null>} */
export async function readDraft(conversationId) {
  const row = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { collectDraft: true } });
  return row?.collectDraft ?? null;
}

/**
 * Replace (or, with null, clear) a conversation's draft.
 * @param {string} conversationId
 * @param {object|null} draft
 */
export async function writeDraft(conversationId, draft) {
  // Prisma needs the explicit marker to store SQL NULL in a Json column.
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { collectDraft: draft ?? Prisma.DbNull },
  });
}
