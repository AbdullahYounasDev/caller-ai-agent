// Fake of ./llm for scripts/test-collect.mjs: deterministic embeddings, and replies/extractions
// the test programs turn by turn. Records every system instruction it was given, so the test
// can check what the engine told the model to say.
export const state = {
  /** system instructions of the reply calls, oldest first */
  instructions: [],
  /** what the next reply starts with / is (a function of the call number, or a string) */
  reply: (n) => `Reply ${n}.`,
  /** what the next extraction returns: an object (JSON-encoded) or a function; null = throw */
  extraction: () => ({ values: {}, date: null, time: null }),
  extractions: 0,
  rewrites: 0,
};

export const vec = (t) => {
  let h = 2166136261;
  for (const c of t) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: 768 }, (_, i) => Math.sin(h + i));
};
export const embedTexts = async (texts) => texts.map(vec);
export const embedText = async (t) => vec(t);
export const EMBEDDING_DIMENSIONS = 768;

const replyFor = () => (typeof state.reply === "function" ? state.reply(state.instructions.length) : state.reply);

export async function generateReply({ systemInstruction, onProvider }) {
  state.instructions.push(systemInstruction);
  onProvider?.("stub:model");
  return replyFor();
}

export async function generateReplyStream({ systemInstruction, onChunk, onProvider }) {
  state.instructions.push(systemInstruction);
  onProvider?.("stub:model");
  const text = replyFor();
  // Stream in small pieces, so a marker can arrive split across chunks.
  for (let i = 0; i < text.length; i += 4) onChunk(text.slice(i, i + 4));
  return text;
}

export async function generateRewrite() {
  state.rewrites++;
  return "rewritten query";
}

export async function generateExtraction() {
  state.extractions++;
  const out = typeof state.extraction === "function" ? state.extraction(state.extractions) : state.extraction;
  if (out === null) throw new Error("stub: extraction down");
  return JSON.stringify(out);
}
