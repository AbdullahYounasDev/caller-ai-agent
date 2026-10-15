import { float32ToPcm16, pcm16ToFloat32 } from "../audio";
import { CLIENT, SERVER } from "../protocol";

/**
 * THE BROWSER TRANSPORT — the test console's microphone and speakers, over one
 * WebSocket speaking the protocol in protocol.js.
 *
 * It does two things and knows nothing about calls: it turns the session's four
 * transport calls (audio / clear / notify / close) into frames, and turns incoming
 * frames into decoded messages. A Twilio Media Streams transport will be a sibling of
 * this file with the same shape (μ-law in base64 JSON instead of PCM16 binary).
 *
 * Every send is guarded: a socket that has gone away must never throw into the call
 * session — the close handler ends the call on its own.
 */

/**
 * @param {import("ws").WebSocket} ws
 */
export function createBrowserTransport(ws) {
  let announcedRate = null;
  const open = () => ws.readyState === ws.OPEN;
  const json = (type, payload) => {
    if (!open()) return;
    if (payload && "type" in payload) {
      // The message type would be silently overwritten by the payload's own `type` —
      // a programming error, surfaced loudly rather than sent as the wrong message.
      throw new Error(`voice: payload for "${type}" must not carry its own "type"`);
    }
    try {
      ws.send(JSON.stringify({ type, ...payload }));
    } catch {
      // the close handler deals with a dead socket
    }
  };

  return {
    audio(samples, sampleRate) {
      if (!open()) return;
      if (sampleRate !== announcedRate) {
        announcedRate = sampleRate;
        json(SERVER.AUDIO_FORMAT, { sampleRate });
      }
      try {
        ws.send(float32ToPcm16(samples), { binary: true });
      } catch {
        // ditto
      }
    },
    clear() {
      json(SERVER.AUDIO_CLEAR, {});
    },
    notify(type, payload) {
      json(type, payload);
    },
    close() {
      if (open()) ws.close(1000, "call ended");
    },
  };
}

/**
 * Decode one incoming frame.
 *
 * @param {Buffer|ArrayBuffer|Buffer[]} data
 * @param {boolean} isBinary
 * @returns {{kind: "audio", samples: Float32Array} | {kind: "hello", ticket: string}
 *   | {kind: "playback", playing: boolean} | {kind: "hangup"} | {kind: "invalid"}}
 */
export function decodeClientFrame(data, isBinary) {
  if (isBinary) {
    const buffer = Array.isArray(data) ? Buffer.concat(data) : data;
    return { kind: "audio", samples: pcm16ToFloat32(buffer) };
  }

  let message;
  try {
    message = JSON.parse(String(data));
  } catch {
    return { kind: "invalid" };
  }
  switch (message?.type) {
    case CLIENT.HELLO:
      return typeof message.ticket === "string" ? { kind: "hello", ticket: message.ticket } : { kind: "invalid" };
    case CLIENT.PLAYBACK:
      return { kind: "playback", playing: Boolean(message.playing) };
    case CLIENT.HANGUP:
      return { kind: "hangup" };
    default:
      return { kind: "invalid" };
  }
}
