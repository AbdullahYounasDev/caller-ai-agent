import http from "node:http";
import { WebSocketServer } from "ws";
import { prisma } from "@/lib/db";
import { respond, trimLastReply, noteUnheard, handoffFailed } from "@/lib/agent/respond";
import { describeChatProvider } from "@/lib/agent/llm";
import { getAgentConfig, invalidateAgentConfig } from "@/lib/tenant/config";
import { assertTenantServiceable } from "@/lib/tenant/registry";
import { loadLocalSpeech } from "./speech/engine";
import { createSpeechToText } from "./speech/stt";
import { createTextToSpeech } from "./speech/tts";
import { VoiceActivity } from "./speech/vad";
import { CallSession } from "./session";
import { CallRecorder } from "./recorder";
import { createBrowserTransport, decodeClientFrame } from "./transports/browser";
import { createTwilioTransport, decodeTwilioMessage } from "./transports/twilio";
import { createTicketVerifier, ticketSecret } from "./ticket";
import { LIMITS, gatewayPort } from "./config";
import { CLOSE_REFUSED, END_REASONS, ERROR_CODES, SERVER } from "./protocol";
import { getVoice, PREVIEW_TEXT } from "./speech/voices";
import { encodeWav } from "./audio";
import { hit } from "@/lib/security/rate-limit";
import { saveRecording } from "@/lib/standins/recordings";

/** Voice previews per client per minute — plenty for someone clicking through the list. */
const PREVIEW_LIMIT = { limit: 30, windowMs: 60_000 };

/**
 * THE VOICE GATEWAY — a small, separate Node process (`npm run voice`) that holds the
 * live audio connections and runs the speech models.
 *
 * WHY A SEPARATE PROCESS. Next.js route handlers answer a request and finish; they
 * cannot hold a WebSocket open for the length of a call. It also keeps the native
 * speech runtime (and its ~1 GB of loaded models) out of the web app, and is exactly
 * the box that moves to its own server when calls need their own CPU (§9.2). It imports
 * the SAME brain the app uses (respond(), via the "@/" alias loader) — it is another
 * adapter over the one brain, not a second one.
 *
 *   GET  /health                 readiness, engines, installed voices, live call count
 *   GET  /voices/preview?voice=  a WAV of that voice saying a fixed sample line (the console's ▶)
 *   WS   /call                   one BROWSER call per socket: { type: "hello", ticket } first, then audio
 *   WS   /twilio                 one PHONE call per socket (Twilio Media Streams, transports/twilio.js): the
 *                                stream's start message carries the ticket the webhook issued (§6.30)
 *
 * Trust: a socket gets nothing until its first message carries a valid, unexpired,
 * unused ticket (ticket.js) — from POST /api/voice/session, where the internal-auth guard and the
 * tenant check (§4, §6.18) run, or, for a phone call, from the Twilio webhook, where the
 * request's signature is verified (§6.30). The tenant check is repeated here because this process
 * SERVES the tenant: if the tenant was suspended after the ticket was issued, the call is still refused.
 */
export async function startVoiceGateway({ env = process.env } = {}) {
  const port = gatewayPort(env);
  const secret = ticketSecret(env);
  if (!secret) throw new Error("VOICE_SESSION_SECRET or INTERNAL_API_KEY must be set in production");
  const tickets = createTicketVerifier({ secret });

  /** @type {Set<CallSession>} */
  const sessions = new Set();
  let speech = null;
  let loadError = null;

  /** voiceId → WAV. A preview is a fixed sentence, so each voice is synthesised once. */
  const previews = new Map();

  const json = (res, status, body) => {
    // Readable from the console's origin: nothing here is about any tenant.
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway");
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });

    if (url.pathname === "/health") {
      // `?tenant=ID` (the Twilio webhook asks before it hands a call over, §6.30) adds ONE boolean —
      // whether that business is under its own concurrent-call limit. Counts are never listed per tenant:
      // this address is unauthenticated.
      const tenant = url.searchParams.get("tenant");
      const tenantAvailable = tenant ? [...sessions].filter((s) => s.tenantId === tenant).length < LIMITS.maxConcurrentCallsPerTenant : undefined;
      return json(res, speech ? 200 : 503, {
        tenantAvailable,
        status: speech ? "ready" : loadError ? "error" : "loading",
        error: loadError ? "speech models failed to load — see the gateway log" : undefined,
        engine: speech?.engineInfo ?? null,
        installedVoices: speech?.engine.installedVoices ?? [],
        activeCalls: sessions.size,
        maxCalls: LIMITS.maxConcurrentCalls,
      });
    }

    if (url.pathname === "/voices/preview") {
      // Unauthenticated on purpose — the console's voice picker plays it from the browser,
      // and it reveals nothing: a fixed sentence per voice from the public catalog. The
      // cost (CPU) is bounded twice: each voice is synthesised at most once, and a client
      // gets PREVIEW_LIMIT requests a minute.
      const limited = hit({ key: `voice:preview:${req.socket.remoteAddress}`, ...PREVIEW_LIMIT });
      if (!limited.ok) return json(res, 429, { error: "too many previews" });
      if (!speech) return json(res, 503, { error: "voice models are still loading" });

      const voice = getVoice(url.searchParams.get("voice") ?? "");
      if (!voice) return json(res, 404, { error: "unknown voice" });
      if (!speech.engine.installedVoices.includes(voice.id)) return json(res, 404, { error: "voice not installed" });

      try {
        if (!previews.has(voice.id)) {
          const audio = await speech.tts.synthesize({ text: PREVIEW_TEXT[voice.language], voiceId: voice.id });
          previews.set(voice.id, encodeWav(audio.samples, audio.sampleRate));
        }
        const wav = previews.get(voice.id);
        res.writeHead(200, {
          "content-type": "audio/wav",
          "content-length": wav.length,
          "access-control-allow-origin": "*",
          "cache-control": "public, max-age=86400",
        });
        return res.end(wav);
      } catch (err) {
        console.error(`[voice] preview of ${voice.id} failed:`, err);
        return json(res, 500, { error: "preview failed" });
      }
    }

    return json(res, 404, { error: "not found" });
  });

  // Two kinds of socket on one port. `noServer` + a hand-written upgrade: ws's `path` option would
  // make the first server destroy the other's connections.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const wssPhone = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://gateway");
    const target = pathname === "/call" ? wss : pathname === "/twilio" ? wssPhone : null;
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  /**
   * Check a verified ticket against what this gateway can serve right now. Shared by both kinds of
   * call. Returns the reason it must be refused, or null.
   */
  async function refusalFor(verdict) {
    if (!speech) return { code: ERROR_CODES.NOT_READY, message: "voice models are still loading" };
    if (!verdict.ok) return { code: ERROR_CODES.BAD_TICKET, message: verdict.reason };
    const serviceable = await assertTenantServiceable(verdict.tenantId);
    if (!serviceable.ok) return { code: ERROR_CODES.BAD_TICKET, message: "tenant cannot be served" };
    if (sessions.size >= LIMITS.maxConcurrentCalls) return { code: ERROR_CODES.BUSY, message: "gateway at capacity" };
    const tenantCalls = [...sessions].filter((s) => s.tenantId === verdict.tenantId).length;
    if (tenantCalls >= LIMITS.maxConcurrentCallsPerTenant) return { code: ERROR_CODES.TENANT_BUSY, message: "too many calls for this tenant" };
    return null;
  }

  /** Build a call session on a transport and answer. */
  function newSession({ verdict, transportName, transport }) {
    return new CallSession({
      tenantId: verdict.tenantId,
      agentId: verdict.agentId,
      line: verdict.line,
      resume: verdict.resume,
      transportName,
      transport,
      stt: speech.stt,
      tts: speech.tts,
      createVad: () => new VoiceActivity({ sherpa: speech.engine.sherpa, config: speech.engine.vadConfig }),
      engineInfo: speech.engineInfo,
      brain: { respond, trimLastReply, noteUnheard, handoffFailed, getAgentConfig, invalidateAgentConfig },
      openRecorder: (args) => CallRecorder.open(args),
      // Phone calls of an agent with recording switched on are kept (standins/recordings.js stands in for the
      // backend's storage); the session decides which calls — see CallSession.shouldRecordAudio.
      saveRecording: (args) => saveRecording({ ...args, env }),
    });
  }

  /** The common end of a call: close its record, forget the session. */
  function onSocketClosed(session) {
    if (!session) return;
    session.end(END_REASONS.DISCONNECTED).finally(() => {
      sessions.delete(session);
      console.log(`[voice] call ${session.recorder?.callId ?? "?"} closed — ${JSON.stringify(session.describe())}`);
    });
  }

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    const transport = createBrowserTransport(ws);
    const refuse = (code, message) => {
      transport.notify(SERVER.ERROR, { code, message });
      ws.close(CLOSE_REFUSED, code);
    };

    /** @type {CallSession|null} */
    let session = null;
    let starting = false;
    const helloTimeout = setTimeout(() => refuse(ERROR_CODES.BAD_TICKET, "no hello"), 5_000);

    ws.on("message", async (data, isBinary) => {
      const frame = decodeClientFrame(data, isBinary);

      if (session) {
        if (frame.kind === "audio") session.onAudio(frame.samples);
        else if (frame.kind === "playback") session.onPlayback(frame.playing);
        else if (frame.kind === "hangup") session.hangup();
        return;
      }

      // Before the call is up only a hello is meaningful; audio sent early is dropped.
      if (frame.kind !== "hello" || starting) return;
      starting = true;
      clearTimeout(helloTimeout);

      if (!speech) return refuse(ERROR_CODES.NOT_READY, "voice models are still loading");
      const verdict = tickets.verify(frame.ticket);
      const refusal = await refusalFor(verdict);
      if (refusal) return refuse(refusal.code, refusal.message);
      if (ws.readyState !== ws.OPEN) return;

      session = newSession({ verdict, transportName: "browser", transport });
      sessions.add(session);
      const started = await session.start();
      if (started) console.log(`[voice] call ${session.recorder.callId} answered for tenant ${verdict.tenantId}, agent ${session.agentId ?? "default"}`);
      else sessions.delete(session);
    });

    ws.on("close", () => {
      clearTimeout(helloTimeout);
      onSocketClosed(session);
    });

    ws.on("error", (err) => console.error("[voice] socket error:", err.message));
  });

  // A PHONE call: Twilio opens this socket when the webhook's TwiML says <Connect><Stream>. There is
  // no way to tell Twilio "refused" except to close — the call then moves on to the TwiML's next verb
  // (a hangup). No heartbeat either: Twilio ends the stream itself (a `stop` message, then close), and
  // the call's own limits (maxCallMs, the silence check-in) end anything else.
  wssPhone.on("connection", (ws) => {
    const transport = createTwilioTransport(ws, { env });
    /** @type {CallSession|null} */
    let session = null;
    let starting = false;
    const startTimeout = setTimeout(() => ws.close(CLOSE_REFUSED, "no start"), 10_000);

    ws.on("message", async (data) => {
      const message = decodeTwilioMessage(data);

      if (session) {
        if (message.kind === "media") session.onAudio(transport.decode(message.payload));
        else if (message.kind === "stop") session.hangup();
        return;
      }
      if (message.kind !== "start" || starting) return;
      starting = true;
      clearTimeout(startTimeout);

      const verdict = message.ticket ? tickets.verify(message.ticket) : { ok: false, reason: "malformed" };
      const refusal = await refusalFor(verdict);
      if (refusal) {
        console.warn(`[voice] phone call refused: ${refusal.code} (${refusal.message})`);
        return ws.close(CLOSE_REFUSED, refusal.code);
      }
      if (ws.readyState !== ws.OPEN) return;

      transport.bind({ streamSid: message.streamSid, callSid: message.callSid });
      session = newSession({ verdict, transportName: "twilio", transport });
      sessions.add(session);
      const started = await session.start();
      if (!started) return void sessions.delete(session);
      session.log("twilio.stream", { callSid: message.callSid, streamSid: message.streamSid });
      console.log(`[voice] phone call ${session.recorder.callId} answered for tenant ${verdict.tenantId}, agent ${session.agentId ?? "default"}`);
    });

    ws.on("close", () => {
      clearTimeout(startTimeout);
      onSocketClosed(session);
    });
    ws.on("error", (err) => console.error("[voice] phone socket error:", err.message));
  });

  // A socket whose peer vanished (laptop lid closed, network dropped) never sends a
  // close frame. Ping it; one that has not answered the previous ping is terminated,
  // which fires "close" and ends its call cleanly.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 20_000);

  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[voice] gateway listening on :${port} (ws /call, ws /twilio, GET /health) — loading speech models…`);

  // Models load AFTER the port is open, so /health can say "loading" instead of the
  // console seeing a refused connection.
  const loadStarted = performance.now();
  try {
    const engine = await loadLocalSpeech(env);
    const stt = createSpeechToText({ engine, env });
    speech = {
      engine,
      stt,
      tts: createTextToSpeech({ engine, env }),
      engineInfo: { ...engine.info, sttRouting: stt.describe(), llm: describeChatProvider() },
    };
    console.log(`[voice] models ready in ${Math.round(performance.now() - loadStarted)} ms — ${engine.info.runtime}`);
  } catch (err) {
    loadError = err;
    console.error(`[voice] could not load speech models:\n${err.message}`);
  }

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    console.log(`[voice] shutting down — ending ${sessions.size} call(s)`);
    clearInterval(heartbeat);
    await Promise.allSettled([...sessions].map((s) => s.end(END_REASONS.SERVER_SHUTDOWN)));
    wss.close();
    wssPhone.close();
    server.close();
    await prisma.$disconnect().catch(() => {});
  }

  return { port, stop, sessions };
}
