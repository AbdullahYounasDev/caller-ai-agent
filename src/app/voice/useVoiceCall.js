"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CALL_STATES, CLIENT, ERROR_CODES, SERVER } from "@/lib/voice/protocol";
import { PcmPlayer } from "./pcm-player";

/**
 * A VOICE CALL FROM THE BROWSER — everything the test console needs to call its agent:
 * the microphone, the WebSocket to the voice gateway, playback, and the live call state.
 *
 * Dial sequence (each step can fail with a specific, translatable reason):
 *   1. microphone permission    — asked FIRST, so the browser's prompt appears the
 *                                 moment "Call" is pressed
 *   2. POST /api/voice/session  — the app checks the tenant, returns a one-minute ticket
 *   3. gateway /health          — is the voice gateway running, and are its models loaded?
 *   4. WebSocket + hello        — the gateway verifies the ticket and answers the call
 *
 * Echo: the mic is opened with the browser's echo cancellation on, so the agent's own
 * voice from the speakers is (mostly) removed before it reaches the gateway — otherwise
 * the agent would hear itself and interrupt itself. Headphones remove the problem.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string|null} [args.agentId]  which agent answers (null = the default agent)
 * @param {string|null} [args.dialNumber] call "as if dialling" this number of the business (§6.29):
 *   the number, through the real lookup, decides the agent instead of agentId
 * @param {string} args.uiLocale  sent to the session route for its error messages
 */
export function useVoiceCall({ tenantId, agentId = null, dialNumber = null, uiLocale }) {
  // idle → preparing → live → ended | error
  const [status, setStatus] = useState("idle");
  const [callState, setCallState] = useState(CALL_STATES.CONNECTING);
  const [callId, setCallId] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  // Who the call is being passed to, once the agent decides (simulated in this console).
  const [transfer, setTransfer] = useState(null);
  const [endReason, setEndReason] = useState(null);
  const [muted, setMuted] = useState(false);
  const [startedAt, setStartedAt] = useState(null);

  const live = useRef(null); // { ws, context, stream, player, worklet, meter }
  const mutedRef = useRef(false);
  const levels = useRef({ mic: 0, agent: 0 });

  const teardown = useCallback(() => {
    const call = live.current;
    live.current = null;
    if (!call) return;
    cancelAnimationFrame(call.meter);
    call.worklet?.port.close();
    call.stream?.getTracks().forEach((track) => track.stop());
    call.player?.clear();
    call.context?.close().catch(() => {});
    if (call.ws && call.ws.readyState <= WebSocket.OPEN) call.ws.close(1000, "client closed");
  }, []);

  /** The UI must never show a call that no longer has a connection behind it. */
  const markEnded = useCallback(() => setStatus((s) => (s === "live" || s === "preparing" ? "ended" : s)), []);

  // A call never outlives the component (navigation, tenant switch, hot reload). If the
  // component survives — a Fast Refresh re-runs effects on a mounted component — the
  // status follows the torn-down connection instead of showing a ghost call.
  useEffect(
    () => () => {
      if (!live.current) return;
      teardown();
      markEnded();
    },
    [teardown, markEnded]
  );

  const fail = useCallback(
    (code) => {
      setError(code);
      setStatus("error");
      teardown();
    },
    [teardown]
  );

  const start = useCallback(async () => {
    if (live.current) return;
    setStatus("preparing");
    setCallState(CALL_STATES.CONNECTING);
    setTranscript([]);
    setEvents([]);
    setError(null);
    setNotice(null);
    setEndReason(null);
    setTransfer(null);
    setCallId(null);
    setStartedAt(null);
    const call = {};
    live.current = call;

    // 1. Microphone.
    try {
      call.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      return fail(err?.name === "NotAllowedError" ? "micDenied" : "micUnavailable");
    }
    if (live.current !== call) return;

    // 2. Ticket.
    let session;
    try {
      const res = await fetch(
        `/api/voice/session?tenantId=${encodeURIComponent(tenantId)}${
          dialNumber ? `&to=${encodeURIComponent(dialNumber)}` : agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""
        }&locale=${encodeURIComponent(uiLocale)}`,
        { method: "POST" }
      );
      session = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(session.error ?? null);
        return fail(res.status === 429 ? "rateLimited" : "refused");
      }
    } catch {
      return fail("refused");
    }
    if (live.current !== call) return;

    // 3. Is the gateway up?
    try {
      const res = await fetch(session.healthUrl, { cache: "no-store" });
      const health = await res.json().catch(() => ({}));
      if (health.status === "loading") return fail("gatewayLoading");
      if (health.status !== "ready") return fail("gatewayError");
    } catch {
      return fail("gatewayOffline");
    }
    if (live.current !== call) return;

    // Audio graph: mic → worklet (16 kHz PCM frames) and gateway → player → speakers.
    try {
      call.context = new AudioContext({ latencyHint: "interactive" });
      await call.context.audioWorklet.addModule("/voice/mic-worklet.js");
      const source = call.context.createMediaStreamSource(call.stream);
      call.worklet = new AudioWorkletNode(call.context, "mic-capture");
      // The worklet has no audible output; a muted sink keeps it pulled by the graph in
      // every browser.
      const sink = call.context.createGain();
      sink.gain.value = 0;
      source.connect(call.worklet).connect(sink).connect(call.context.destination);
      call.player = new PcmPlayer(call.context, (playing) => send(call, { type: CLIENT.PLAYBACK, playing }));
    } catch {
      return fail("micUnavailable");
    }
    if (live.current !== call) return;

    // 4. Dial.
    const ws = new WebSocket(session.url);
    ws.binaryType = "arraybuffer";
    call.ws = ws;
    let answered = false;

    ws.onopen = () => send(call, { type: CLIENT.HELLO, ticket: session.ticket });

    call.worklet.port.onmessage = ({ data }) => {
      levels.current.mic = mutedRef.current ? 0 : data.level;
      if (!answered || mutedRef.current || ws.readyState !== WebSocket.OPEN) return;
      ws.send(data.pcm);
    };

    ws.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        call.player.enqueue(data);
        return;
      }
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }

      switch (message.type) {
        case SERVER.READY:
          answered = true;
          setCallId(message.callId);
          setStartedAt(Date.now());
          setStatus("live");
          break;
        case SERVER.STATE:
          setCallState(message.state);
          break;
        case SERVER.AUDIO_FORMAT:
          call.player.setFormat(message.sampleRate);
          break;
        case SERVER.AUDIO_CLEAR:
          call.player.clear();
          break;
        case SERVER.TRANSCRIPT:
          setTranscript((t) => [...t, { role: "caller", turn: message.turn, text: message.text, sttMs: message.sttMs }]);
          break;
        case SERVER.AGENT_TEXT:
          setTranscript((t) => appendAgentText(t, message.turn, message.text));
          break;
        case SERVER.TURN:
          setTranscript((t) => attachTurnMeta(t, message));
          break;
        case SERVER.EVENT:
          setEvents((e) => [...e, message.event]);
          break;
        case SERVER.TRANSFER:
          setTransfer({ contact: message.contact, simulated: Boolean(message.simulated) });
          break;
        case SERVER.ENDED:
          setEndReason(message.reason);
          break;
        case SERVER.ERROR:
          // A failed turn is not a failed call: the agent apologises and keeps listening.
          if (message.code === ERROR_CODES.TURN_FAILED) setNotice("turnFailed");
          else if (!answered) fail(message.code);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      if (live.current !== call) return;
      teardown();
      setStatus((s) => (s === "error" ? s : answered ? "ended" : "error"));
      if (!answered) setError((e) => e ?? "gatewayOffline");
    };

    // Level meters, read once per animation frame (cheap; no React state).
    const tick = () => {
      if (live.current !== call) return;
      levels.current.agent = call.player.level();
      call.meter = requestAnimationFrame(tick);
    };
    call.meter = requestAnimationFrame(tick);
  }, [tenantId, agentId, dialNumber, uiLocale, fail, teardown]);

  const hangup = useCallback(() => {
    const call = live.current;
    if (!call) return markEnded();
    send(call, { type: CLIENT.HANGUP });
    // The gateway closes the socket after writing the call record; if it is unreachable,
    // do not leave the microphone open waiting for it.
    setTimeout(() => {
      if (live.current === call) {
        teardown();
        markEnded();
      }
    }, 3000);
  }, [teardown, markEnded]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
  }, []);

  return { status, callState, callId, transcript, events, error, notice, transfer, endReason, muted, startedAt, levels, start, hangup, toggleMute };
}

function send(call, message) {
  if (call.ws?.readyState === WebSocket.OPEN) call.ws.send(JSON.stringify(message));
}

/** Sentences of one agent turn arrive one at a time; they belong in ONE bubble. */
function appendAgentText(transcript, turn, text) {
  const last = transcript[transcript.length - 1];
  if (last?.role === "agent" && last.turn === turn) {
    return [...transcript.slice(0, -1), { ...last, text: `${last.text} ${text}` }];
  }
  return [...transcript, { role: "agent", turn, text }];
}

/** A turn's summary (intent, outcome, sources, timings) goes under its agent bubble. */
function attachTurnMeta(transcript, meta) {
  const index = transcript.findLastIndex((m) => m.role === "agent" && m.turn === meta.turn);
  if (index === -1) return [...transcript, { role: "agent", turn: meta.turn, text: "", meta }];
  const next = [...transcript];
  next[index] = { ...next[index], meta };
  return next;
}
