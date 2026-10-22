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
import { createTicketVerifier, ticketSecret } from "./ticket";
import { LIMITS, gatewayPort } from "./config";
import { CLOSE_REFUSED, END_REASONS, ERROR_CODES, SERVER } from "./protocol";
import { getVoice, PREVIEW_TEXT } from "./speech/voices";
import { encodeWav } from "./audio";
import { hit } from "@/lib/security/rate-limit";

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
 *   WS   /call                   one call per socket: { type: "hello", ticket } first, then audio
 *
 * Trust: a socket gets nothing until its first message carries a valid, unexpired,
 * unused ticket from POST /api/voice/session (ticket.js) — that route is where the
 * internal-auth guard and the tenant check (§4, §6.18) run. The tenant check is
 * repeated here because this process SERVES the tenant: if the tenant was suspended
 * after the ticket was issued, the call is still refused.
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
      return json(res, speech ? 200 : 503, {
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

  const wss = new WebSocketServer({ server, path: "/call", maxPayload: 256 * 1024 });

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
      if (!verdict.ok) return refuse(ERROR_CODES.BAD_TICKET, verdict.reason);
      const tenantId = verdict.tenantId;
      const agentId = verdict.agentId;
      const line = verdict.line;

      const serviceable = await assertTenantServiceable(tenantId);
      if (!serviceable.ok) return refuse(ERROR_CODES.BAD_TICKET, "tenant cannot be served");

      if (sessions.size >= LIMITS.maxConcurrentCalls) return refuse(ERROR_CODES.BUSY, "gateway at capacity");
      const tenantCalls = [...sessions].filter((s) => s.tenantId === tenantId).length;
      if (tenantCalls >= LIMITS.maxConcurrentCallsPerTenant) {
        return refuse(ERROR_CODES.TENANT_BUSY, "too many calls for this tenant");
      }
      if (ws.readyState !== ws.OPEN) return;

      session = new CallSession({
        tenantId,
        agentId,
        line,
        transportName: "browser",
        transport,
        stt: speech.stt,
        tts: speech.tts,
        createVad: () => new VoiceActivity({ sherpa: speech.engine.sherpa, config: speech.engine.vadConfig }),
        engineInfo: speech.engineInfo,
        brain: { respond, trimLastReply, noteUnheard, handoffFailed, getAgentConfig, invalidateAgentConfig },
        openRecorder: (args) => CallRecorder.open(args),
      });
      sessions.add(session);
      const started = await session.start();
      if (started) console.log(`[voice] call ${session.recorder.callId} answered for tenant ${tenantId}, agent ${session.agentId ?? "default"}`);
      else sessions.delete(session);
    });

    ws.on("close", () => {
      clearTimeout(helloTimeout);
      if (!session) return;
      const s = session;
      s.end(END_REASONS.DISCONNECTED).finally(() => {
        sessions.delete(s);
        console.log(`[voice] call ${s.recorder?.callId ?? "?"} closed — ${JSON.stringify(s.describe())}`);
      });
    });

    ws.on("error", (err) => console.error("[voice] socket error:", err.message));
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
  console.log(`[voice] gateway listening on :${port} (ws /call, GET /health) — loading speech models…`);

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
    server.close();
    await prisma.$disconnect().catch(() => {});
  }

  return { port, stop, sessions };
}
