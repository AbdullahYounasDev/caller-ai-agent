import { voiceLine } from "@/lib/agent/prompt";
import { voiceFor } from "./speech/voices";

/**
 * A REFUSED PHONE CALL IS TOLD OUT LOUD (CLAUDE.md §6.30, "capacity refusals that happen AFTER the stream opened").
 *
 * The Twilio webhook already asks the gateway whether it has room before it hands a call over, and says "all of our
 * lines are busy" itself when it does not. That check is a snapshot: a call can slip in between it and the moment
 * the stream opens, and the gateway then refuses it — and the only thing it could do was close the socket, which a
 * caller hears as the call going dead. Here the audio stream is already open in both directions, so the gateway says
 * the same fixed line itself first.
 *
 * Rules:
 *  - ONLY a call whose ticket was valid is spoken to. A bad or forged ticket gets a plain close: nothing said, nothing
 *    learned about this system.
 *  - The line is fixed text (prompt.js voiceLine — no model, no retrieval), in the agent's reply language when the
 *    agent can be read, English otherwise, and spoken with the agent's own voice for that language. It is synthesised
 *    once per voice and then served from the cache (tts.js `cache: true`), so a flood of refused calls costs frames,
 *    not CPU. `prewarm` does the first synthesis at start-up while the gateway is still idle.
 *  - It must NEVER make a bad moment worse: at most `maxSpeaking` refusals are voiced at once (the rest are closed
 *    silently, as before), the wait is capped, and any failure falls back to the plain close.
 *  - It never touches the session list: a refused call is not a call.
 */

/** Which fixed line each reason is told with. A reason not listed here is closed without a word. */
export const REFUSAL_LINES = {
  busy: "busy",
  tenant_busy: "busy",
  not_ready: "fallback",
  not_in_service: "not_in_service",
};

/** How long after the last sample was handed over the caller may still be hearing it (network + the phone's buffer). */
export const PLAYBACK_SLACK_MS = 600;
/** Never keep a refused caller on the line longer than this. */
export const MAX_WAIT_MS = 12_000;
export const MAX_SPEAKING = 20;

let speaking = 0;

/**
 * @param {object} args
 * @param {{code: string, line?: string}} args.refusal   `line` names the fixed line (REFUSAL_LINES key); absent = say nothing
 * @param {{ok: boolean, tenantId?: string, agentId?: string|null}} args.verdict   the verified ticket
 * @param {{streamSid: string|null, audio: Function}} args.transport   a bound phone transport
 * @param {{synthesize: Function}} args.tts
 * @param {(tenantId: string, options: {agentId: string|null}) => Promise<{replyLanguage?: string, voices?: object}>} args.getAgentConfig
 * @param {() => boolean} args.isOpen    is the caller still on the line
 * @param {(ms: number) => Promise<void>} [args.sleep]
 * @returns {Promise<{spoken: boolean, reason?: string, language?: string, ms?: number}>}
 */
export async function speakRefusal({ refusal, verdict, transport, tts, getAgentConfig, isOpen, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const kind = REFUSAL_LINES[refusal?.line];
  if (!kind) return { spoken: false, reason: "no_line" };
  if (!verdict?.ok) return { spoken: false, reason: "unverified" };
  if (!transport?.streamSid) return { spoken: false, reason: "no_stream" };
  if (!isOpen()) return { spoken: false, reason: "closed" };
  if (speaking >= MAX_SPEAKING) return { spoken: false, reason: "too_many" };

  speaking++;
  try {
    const { language, voices } = await readLanguage({ verdict, getAgentConfig });
    const text = voiceLine(kind, language);
    const voiceId = voiceFor(voices, language).id;
    let audio;
    try {
      audio = await tts.synthesize({ text, voiceId, language, cache: true });
    } catch {
      return { spoken: false, reason: "tts_failed" };
    }
    if (!isOpen()) return { spoken: false, reason: "closed" };
    transport.audio(audio.samples, audio.sampleRate);

    // Let it reach the caller's ear before the stream is closed: the audio is queued at Twilio and played in real time.
    const playMs = (audio.samples.length / audio.sampleRate) * 1000;
    const waitMs = Math.min(MAX_WAIT_MS, playMs + PLAYBACK_SLACK_MS);
    for (let waited = 0; waited < waitMs && isOpen(); waited += 250) await sleep(Math.min(250, waitMs - waited));
    return { spoken: true, language, ms: Math.round(playMs) };
  } finally {
    speaking--;
  }
}

/** The agent's reply language and voices, "en" and the defaults when they cannot be read. */
async function readLanguage({ verdict, getAgentConfig }) {
  try {
    const config = await getAgentConfig(verdict.tenantId, { agentId: verdict.agentId ?? null });
    return { language: config?.replyLanguage === "ur" ? "ur" : "en", voices: config?.voices };
  } catch {
    return { language: "en", voices: undefined };
  }
}

/**
 * Make the first synthesis of the refusal lines happen now, while the gateway is idle: a refused call is, by
 * definition, one that arrives when the gateway is busiest.
 * @param {{synthesize: Function}} tts
 */
export async function prewarmRefusalLines(tts) {
  // Only the common one ("busy", in the default voice of each language): the others are rare, and each synthesis is
  // seconds of CPU at the moment the gateway is also loading its first calls.
  for (const language of ["en", "ur"]) {
    try {
      await tts.synthesize({ text: voiceLine("busy", language), voiceId: voiceFor(undefined, language).id, language, cache: true });
    } catch {
      // a missing voice is not a reason to stop the gateway starting
    }
  }
}
