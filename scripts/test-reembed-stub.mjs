// Fake of ./llm for scripts/test-reembed.mjs — deterministic vectors, programmable failures.
export const state = { calls: [], failOnCall: null, onCall: null, role: [], texts: [] };
export const vec = (t) => { let h = 2166136261; for (const c of t) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return Array.from({ length: 768 }, (_, i) => Math.sin(h + i) ); };
export async function embedTexts(texts, { role } = {}) {
  state.calls.push(texts.length); state.role.push(role); state.texts.push(...texts);
  if (state.onCall) await state.onCall(state.calls.length);
  if (state.failOnCall === state.calls.length) { const e = new Error("stub: quota"); e.status = 429; throw e; }
  return texts.map(vec);
}
export const embedText = async (t, o) => (await embedTexts([t], o))[0];
