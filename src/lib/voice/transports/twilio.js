import { createUpsampler2, float32ToMulaw, mulawToFloat32, resample } from "../audio";
import { buildTransferTwiml } from "@/lib/telephony/twilio-webhook";
import { redirectCall } from "@/lib/telephony/twilio-rest";
import { twilioConfig } from "@/lib/telephony/twilio-config";
import { ticketSecret } from "../ticket";

/**
 * THE TWILIO TRANSPORT — a phone call, over Twilio Media Streams (CLAUDE.md §6.30). A sibling of
 * transports/browser.js with the same four calls the session makes (audio / clear / notify / close)
 * plus a real `transfer`; it knows nothing about calls, only about Twilio's wire format.
 *
 *   Twilio → us    JSON messages: connected, start {streamSid, callSid, customParameters}, media
 *                  {payload: base64 μ-law, 8 kHz, 20 ms}, stop (+ mark, dtmf, ignored)
 *   us → Twilio    media {streamSid, media: {payload}}  — the agent's voice, μ-law, 20 ms frames
 *                  clear {streamSid}                    — barge-in: throw away what is still queued
 *
 * Inside the gateway everything is 16 kHz float32 (SAMPLE_RATE): what arrives is decoded and
 * up-sampled with a streaming filter, what is spoken is down-sampled with a low-pass (so the
 * voice's 22–24 kHz does not fold into a metallic hiss) and encoded. Twilio queues what it is
 * sent and plays it in real time, so a whole sentence goes out at once; the session's own estimate
 * of when it ends (audioPlaysUntil) is what "the agent is still talking" means, as on every transport.
 *
 * Every send is guarded: a socket that has gone away must never throw into the call session.
 * Tests: tests/twilio-transport.test.mjs.
 */

/** μ-law bytes per message: 20 ms at 8 kHz, what Twilio sends and expects. */
const FRAME_BYTES = 160;
/** Before a transfer replaces the call, let the last words reach the caller's ear. */
const TRANSFER_SETTLE_MS = 500;

/**
 * @param {import("ws").WebSocket} ws
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 */
export function createTwilioTransport(ws, { env = process.env, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  /** Set from the stream's start message; nothing can be sent before it. */
  let streamSid = null;
  let callSid = null;
  const open = () => ws.readyState === ws.OPEN;
  const send = (message) => {
    if (!open()) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // the close handler deals with a dead socket
    }
  };
  const upsampler = createUpsampler2();

  return {
    /** The stream started: from here the agent can speak. */
    bind({ streamSid: sid, callSid: call }) {
      streamSid = sid;
      callSid = call;
    },
    get callSid() {
      return callSid;
    },
    get streamSid() {
      return streamSid;
    },

    /** One of Twilio's inbound media payloads → what the VAD takes (16 kHz float32). */
    decode(payloadBase64) {
      return upsampler.push(mulawToFloat32(Buffer.from(payloadBase64, "base64")));
    },

    audio(samples, sampleRate) {
      if (!streamSid) return;
      const phone = float32ToMulaw(resample(samples, sampleRate, 8_000));
      for (let at = 0; at < phone.length; at += FRAME_BYTES) {
        send({ event: "media", streamSid, media: { payload: phone.subarray(at, at + FRAME_BYTES).toString("base64") } });
      }
    },
    clear() {
      if (streamSid) send({ event: "clear", streamSid });
    },
    /** Twilio has no use for the console's progress messages. */
    notify() {},
    close() {
      if (open()) ws.close(1000, "call ended");
    },

    /**
     * Pass the call to people, in order. A transfer is "replace this live call's instructions with a
     * <Dial>" (twilio-rest.js): Twilio ends our stream and rings the first person with a short
     * summary read to them before the two are connected; if they do not pick up, Twilio asks our
     * transfer webhook, which rings the next (twilio-webhook.js continueTransfer).
     *
     * `connected: true` means the call has LEFT the agent — whether anyone then answers is Twilio's
     * business from there on. When nobody does, the transfer webhook brings the call BACK to the agent
     * (a new stream whose ticket carries `resume`: the conversation to carry on, §6.30), so a call-back
     * can be taken; without `resume` it ends with a fixed line and goodbye. `connected: false` (the instruction was refused, or
     * Twilio is unreachable) leaves the call with the agent, which then says nobody is available.
     *
     * @param {Array<{phone: string, role?: string, name?: string}>} contacts  in the order to try
     * @param {{summary?: string, resume?: object}} [context]  `resume`: where the call comes back to (tenant, agent,
     *   line, conversation, call, language, how many times it already has) — see twilio-webhook.js
     * @returns {Promise<{connected: boolean, reason?: "failed"}>}
     */
    async transferInOrder(contacts, { summary = "", resume = null } = {}) {
      const config = twilioConfig(env);
      const secret = ticketSecret(env);
      if (!callSid || !config.canTransfer || !secret) return { connected: false, reason: "failed" };
      const twiml = buildTransferTwiml({ contacts, index: 0, summary, resume, config, secret, now: now() });
      if (!twiml) return { connected: false, reason: "failed" };
      await sleep(TRANSFER_SETTLE_MS);
      const result = await redirectCall({ accountSid: config.accountSid, authToken: config.authToken, callSid, twiml, fetchImpl });
      if (!result.ok) {
        console.error(`[voice] Twilio refused the transfer (${result.reason}${result.status ? ` ${result.status}` : ""})`);
        return { connected: false, reason: "failed" };
      }
      return { connected: true };
    },
  };
}

/**
 * Decode one message from Twilio.
 *
 * @param {Buffer|ArrayBuffer|Buffer[]|string} data
 * @returns {{kind: "connected"} | {kind: "start", streamSid: string, callSid: string, ticket: string|null}
 *   | {kind: "media", payload: string} | {kind: "mark", name: string} | {kind: "stop"} | {kind: "ignored"} | {kind: "invalid"}}
 */
export function decodeTwilioMessage(data) {
  let message;
  try {
    message = JSON.parse(Array.isArray(data) ? Buffer.concat(data).toString() : String(data));
  } catch {
    return { kind: "invalid" };
  }
  switch (message?.event) {
    case "connected":
      return { kind: "connected" };
    case "start": {
      const start = message.start ?? {};
      const ticket = start.customParameters?.ticket;
      if (typeof start.streamSid !== "string" || typeof start.callSid !== "string") return { kind: "invalid" };
      return { kind: "start", streamSid: start.streamSid, callSid: start.callSid, ticket: typeof ticket === "string" ? ticket : null };
    }
    case "media":
      // Only what the CALLER says: with both tracks on, outbound audio is echoed back to us.
      return typeof message.media?.payload === "string" && (message.media.track ?? "inbound") === "inbound" ? { kind: "media", payload: message.media.payload } : { kind: "ignored" };
    case "mark":
      return { kind: "mark", name: String(message.mark?.name ?? "") };
    case "stop":
      return { kind: "stop" };
    default:
      return { kind: "ignored" };
  }
}
