/**
 * THE BROWSER ⇄ GATEWAY WIRE PROTOCOL — the single definition both sides import, so a
 * renamed message is a broken import, not a silent no-op.
 *
 * Pure constants, no Node or browser APIs: it is imported by the gateway
 * (transports/browser.js) and by the test console (src/app/voice/).
 *
 * TWO KINDS OF FRAME on one WebSocket:
 *   - BINARY frames are audio. Browser → gateway: 16 kHz mono PCM16 (little-endian),
 *     ~20 ms per frame. Gateway → browser: PCM16 at the rate announced by the most
 *     recent AUDIO_FORMAT message (Piper voices speak at 22.05 kHz).
 *   - TEXT frames are JSON control messages: { type, ...payload }.
 *
 * A phone call (Twilio, later) does NOT speak this protocol — it has its own transport
 * adapter. Everything behind the transport (the call session) is shared.
 */

/** Browser → gateway. */
export const CLIENT = {
  /** First message after the socket opens: { ticket } from POST /api/voice/session. */
  HELLO: "hello",
  /** The browser's playback queue state: { playing: boolean }. The agent counts as
   *  "speaking" until the browser says the audio has actually finished playing. */
  PLAYBACK: "playback",
  /** The caller pressed "end call". */
  HANGUP: "hangup",
};

/** Gateway → browser. */
export const SERVER = {
  /** The call is live: { callId, conversationId, engine }. */
  READY: "ready",
  /** What the agent is doing: { state } — one of CALL_STATES. */
  STATE: "state",
  /** The caller's words, once transcribed: { turn, text, sttMs }. */
  TRANSCRIPT: "transcript",
  /** One sentence of the agent's reply, as it is sent to speech: { turn, text }. */
  AGENT_TEXT: "agent_text",
  /** A turn finished: { turn, intent, outcome, topic, sources, timings, interrupted }. */
  TURN: "turn",
  /** The format of the binary audio frames that follow: { sampleRate }. */
  AUDIO_FORMAT: "audio_format",
  /** Drop everything queued for playback NOW — the caller interrupted. */
  AUDIO_CLEAR: "audio_clear",
  /** A timeline entry, mirrored live from the call_events log:
   *  { event: { seq, type, atMs, data } } — nested, because the event has a `type` too. */
  EVENT: "event",
  /** The call is over: { reason }. The socket closes right after. */
  ENDED: "ended",
  /** Something failed: { code, message }. */
  ERROR: "error",
};

/** What the agent is doing, as shown to whoever is on the call. */
export const CALL_STATES = {
  CONNECTING: "connecting",
  /** Waiting for the caller. */
  LISTENING: "listening",
  /** The caller is talking. */
  HEARING: "hearing",
  /** Transcribing, retrieving, generating — the silence the latency budget is about. */
  THINKING: "thinking",
  /** Audio is playing. */
  SPEAKING: "speaking",
  ENDED: "ended",
};

/** Why a call ended — the values written to call_logs.end_reason. */
export const END_REASONS = {
  CALLER_HANGUP: "caller_hangup",
  /** The session could not be set up (no config, recorder failed…). */
  SETUP_FAILED: "setup_failed",
  IDLE: "idle_timeout",
  MAX_DURATION: "max_duration",
  DISCONNECTED: "disconnected",
  SERVER_SHUTDOWN: "server_shutdown",
  ERROR: "error",
};

/** Machine-readable reasons a call is refused or fails. The console translates them. */
export const ERROR_CODES = {
  BAD_TICKET: "bad_ticket",
  BUSY: "busy",
  TENANT_BUSY: "tenant_busy",
  NOT_READY: "not_ready",
  TURN_FAILED: "turn_failed",
  INTERNAL: "internal",
};

/** WebSocket close code for a deliberate, clean end (RFC 6455 "normal closure"). */
export const CLOSE_NORMAL = 1000;
/** Close code for a refused session (application range 4000–4999). */
export const CLOSE_REFUSED = 4001;
