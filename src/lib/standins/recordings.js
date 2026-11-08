import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * STAND-IN for the backend's CALL RECORDING STORAGE (docs/handoff-to-backend.md B11c; CLAUDE.md §4, §6.30).
 *
 * WHERE recordings live, for how long, and who may hear them is the BACKEND's decision (object storage,
 * retention, access control, legal hold). Until it exists the engine keeps a call's stereo WAV in a local
 * folder so the whole path — switch on, call, hear it back, delete it — works and can be tested:
 *
 *   <RECORDINGS_DIR>/<tenantId>/<callId>.wav        (default ./recordings, gitignored; files 0600, folders 0700)
 *
 * Because the voice gateway WRITES and the web app READS, the stand-in only works while both see the same
 * folder (one machine). The real storage replaces this whole file; `call_logs.recording_url` then holds
 * its URL instead of the `file:` reference below. Nothing outside this folder knows how it is kept.
 *
 * Every function takes `tenantId` first, and builds its path only from a validated tenant id and call id
 * (never from a request's path), so one business can neither read nor delete another's recording.
 * `saveRecording` never throws: a lost recording must never become a dropped call or a failed hang-up.
 */

const TENANT = /^[A-Za-z0-9_-]{1,100}$/; // the shape registry.js requireServiceableTenant() enforces
const CALL = /^[A-Za-z0-9-]{1,64}$/; // a uuid

/** The folder recordings are kept in. */
export function recordingsDir(env = process.env) {
  return path.resolve(env.RECORDINGS_DIR?.trim() || "recordings");
}

function locate(tenantId, callId, env) {
  if (!TENANT.test(String(tenantId ?? "")) || !CALL.test(String(callId ?? ""))) return null;
  const dir = path.join(recordingsDir(env), tenantId);
  return { dir, file: path.join(dir, `${callId}.wav`) };
}

/** What `call_logs.recording_url` holds for a recording kept here. */
export const recordingReference = (tenantId, callId) => `file:${tenantId}/${callId}.wav`;

/**
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.callId
 * @param {Buffer} args.wav
 * @param {Record<string, string|undefined>} [args.env]
 * @returns {Promise<string|null>}  the reference to store on the call, or null if it could not be kept
 */
export async function saveRecording({ tenantId, callId, wav, env = process.env }) {
  const where = locate(tenantId, callId, env);
  if (!where || !wav?.length) return null;
  try {
    await mkdir(where.dir, { recursive: true, mode: 0o700 });
    await writeFile(where.file, wav, { mode: 0o600 });
    return recordingReference(tenantId, callId);
  } catch (err) {
    console.error(`[recordings] could not keep the recording of call ${callId}:`, err?.message ?? err);
    return null;
  }
}

/** @returns {Promise<Buffer|null>} null when there is no such recording for THIS tenant */
export async function readRecording({ tenantId, callId, env = process.env }) {
  const where = locate(tenantId, callId, env);
  if (!where) return null;
  return readFile(where.file).catch(() => null);
}

/** @returns {Promise<boolean>} whether a file was there to delete */
export async function deleteRecording({ tenantId, callId, env = process.env }) {
  const where = locate(tenantId, callId, env);
  if (!where) return false;
  const existed = await readFile(where.file).then(() => true, () => false);
  await rm(where.file, { force: true }).catch(() => {});
  return existed;
}
