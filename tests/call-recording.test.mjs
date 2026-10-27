import "./helpers/no-db.mjs";
import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CallAudioRecorder, RECORDING_RATE, encodeStereoWav } from "@/lib/voice/call-audio";
import { deleteRecording, readRecording, recordingReference, saveRecording } from "@/lib/standins/recordings";

// Call recording (CLAUDE.md §6.30): a stereo WAV on one timeline — the caller left, the agent right,
// the agent only as far as it was actually heard — kept by a stand-in store that cannot be pointed at
// another business's files.

/** Caller audio as the session receives it: 16 kHz, `ms` long, constant value. */
const caller16k = (ms, value = 0.5) => new Float32Array((ms * 16_000) / 1000).fill(value);
const agent = (ms, rate, value = 0.25) => new Float32Array((ms * rate) / 1000).fill(value);
const readWav = (wav) => {
  const frames = (wav.length - 44) / 4;
  const left = new Int16Array(frames);
  const right = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = wav.readInt16LE(44 + i * 4);
    right[i] = wav.readInt16LE(44 + i * 4 + 2);
  }
  return { left, right, channels: wav.readUInt16LE(22), rate: wav.readUInt32LE(24), bits: wav.readUInt16LE(34) };
};
const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms) => (t += ms) };
};
const level = (track, fromMs, toMs) => {
  const part = track.subarray((fromMs * RECORDING_RATE) / 1000, (toMs * RECORDING_RATE) / 1000);
  return part.length ? part.reduce((s, v) => s + Math.abs(v), 0) / part.length : 0;
};

describe("the call's audio on one timeline", () => {
  test("a stereo 16-bit WAV at the phone rate: the caller on the left, the agent on the right", () => {
    const c = clock();
    const rec = new CallAudioRecorder({ now: c.now });
    rec.caller(caller16k(1000));
    rec.agent(agent(500, 24_000), 24_000);
    const wav = rec.toWav();
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    const { left, right, channels, rate, bits } = readWav(wav);
    assert.deepEqual([channels, rate, bits], [2, RECORDING_RATE, 16]);
    assert.equal(left.length, RECORDING_RATE, "one second of the caller");
    assert.ok(level(left, 100, 900) > 10_000, "the caller is on the left");
    assert.ok(level(right, 100, 400) > 5_000, "the agent is on the right, from the start (nothing queued)");
    assert.ok(level(right, 600, 900) < 50, "and silent once it has finished");
    assert.equal(wav.readUInt32LE(4), wav.length - 8, "a valid RIFF size");
    assert.equal(wav.readUInt32LE(40), wav.length - 44, "and data size");
  });

  test("the agent is placed where the caller hears it: after what is already queued, at the time it was sent", () => {
    const c = clock();
    const rec = new CallAudioRecorder({ now: c.now });
    rec.caller(caller16k(100));
    c.advance(1000);
    rec.agent(agent(1000, 8_000, 0.5), 8_000); // plays 1000–2000 ms
    c.advance(200);
    rec.agent(agent(500, 8_000, 0.9), 8_000); // sent at 1200 ms but queued behind the first: plays 2000–2500 ms
    const { right } = readWav(rec.toWav());
    assert.ok(level(right, 0, 900) < 50, "silence before the first sentence");
    assert.ok(level(right, 1100, 1900) > 10_000 && level(right, 1100, 1900) < 20_000, "the first sentence at its time");
    assert.ok(level(right, 2100, 2400) > 25_000, "the second behind it, not on top of it");
  });

  test("a barge-in throws away what had not played yet — the recording holds what was heard", () => {
    const c = clock();
    const rec = new CallAudioRecorder({ now: c.now });
    rec.agent(agent(3000, 24_000), 24_000); // would play 0–3000 ms
    rec.agent(agent(2000, 24_000), 24_000); // queued 3000–5000 ms
    c.advance(1000);
    rec.cut();
    const { right } = readWav(rec.toWav());
    assert.equal(right.length, RECORDING_RATE, "nothing after the moment the caller cut in");
    assert.ok(level(right, 200, 900) > 5_000, "what played before it is kept");
    rec.agent(agent(500, 24_000), 24_000);
    const after = readWav(rec.toWav()).right;
    assert.ok(level(after, 1100, 1400) > 5_000, "and the next thing the agent says starts from the cut, not from the end of the old queue");
  });

  test("an empty call has no recording; loud audio is clipped, never wrapped", () => {
    assert.equal(new CallAudioRecorder().toWav(), null);
    const rec = new CallAudioRecorder({ now: clock().now });
    rec.caller(new Float32Array(16).fill(3));
    rec.agent(new Float32Array(8).fill(-3), 8_000);
    const { left, right } = readWav(rec.toWav());
    assert.deepEqual([left[0], right[0]], [32767, -32768]);
  });

  test("the caller's 16 kHz is the phone's 8 kHz again (every second sample); both tracks are as long as the longer", () => {
    const rec = new CallAudioRecorder();
    rec.caller(Float32Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? i / 100 : 0.99)));
    const { left } = readWav(rec.toWav());
    assert.deepEqual([...left].map((v) => Math.round((v / 32767) * 100)), [0, 2, 4, 6, 8, 10, 12, 14]);
    assert.equal(encodeStereoWav(new Int16Array(3), new Int16Array(3), 8000).length, 44 + 12);
  });
});

describe("the stand-in recording storage", () => {
  const withDir = async (body) => {
    const dir = await mkdtemp(path.join(tmpdir(), "recordings-test-"));
    try {
      await body({ RECORDINGS_DIR: dir }, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const wav = Buffer.from("RIFF-fake-wav-bytes");

  test("saves under <tenant>/<call>.wav with private permissions, reads it back, deletes it", () =>
    withDir(async (env, dir) => {
      const ref = await saveRecording({ tenantId: "clinic-1", callId: "call-abc-123", wav, env });
      assert.equal(ref, recordingReference("clinic-1", "call-abc-123"));
      assert.equal(ref, "file:clinic-1/call-abc-123.wav");
      const file = path.join(dir, "clinic-1", "call-abc-123.wav");
      assert.deepEqual(await readFile(file), wav);
      assert.equal((await stat(file)).mode & 0o077, 0, "not readable by other users");
      assert.deepEqual(await readRecording({ tenantId: "clinic-1", callId: "call-abc-123", env }), wav);
      assert.equal(await deleteRecording({ tenantId: "clinic-1", callId: "call-abc-123", env }), true);
      assert.equal(await readRecording({ tenantId: "clinic-1", callId: "call-abc-123", env }), null);
      assert.equal(await deleteRecording({ tenantId: "clinic-1", callId: "call-abc-123", env }), false);
    }));

  test("one business cannot read or delete another's recording, and no id can walk out of the folder", () =>
    withDir(async (env) => {
      await saveRecording({ tenantId: "clinic-1", callId: "call-1", wav, env });
      assert.equal(await readRecording({ tenantId: "clinic-2", callId: "call-1", env }), null);
      assert.equal(await deleteRecording({ tenantId: "clinic-2", callId: "call-1", env }), false);
      assert.notEqual(await readRecording({ tenantId: "clinic-1", callId: "call-1", env }), null, "and the owner's is untouched");
      for (const [tenantId, callId] of [["../clinic-1", "call-1"], ["clinic-1", "../call-1"], ["clinic-1/sub", "call-1"], ["", "call-1"], ["clinic-1", "a/b"], ["clinic-1", ""]]) {
        assert.equal(await saveRecording({ tenantId, callId, wav, env }), null, `${tenantId}|${callId}`);
        assert.equal(await readRecording({ tenantId, callId, env }), null);
        assert.equal(await deleteRecording({ tenantId, callId, env }), false);
      }
    }));

  test("a store that cannot be written is a null, never a thrown error into the hang-up", async () => {
    // The "folder" is a plain file, so a folder cannot be made inside it.
    await withDir(async (env, dir) => {
      const blocker = path.join(dir, "not-a-folder");
      await writeFile(blocker, "x");
      assert.equal(await saveRecording({ tenantId: "t", callId: "c", wav, env: { RECORDINGS_DIR: blocker } }), null);
    });
    assert.equal(await saveRecording({ tenantId: "t", callId: "c", wav: Buffer.alloc(0), env: {} }), null, "nothing to keep");
  });
});
