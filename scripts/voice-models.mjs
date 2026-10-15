#!/usr/bin/env node
/**
 * Download the local speech models the voice gateway needs (npm run voice:models).
 *
 * ≈620 MB from the official k2-fsa/sherpa-onnx GitHub releases, into VOICE_MODELS_DIR
 * (default ./models/voice — gitignored). Idempotent: a model already on disk is
 * skipped, so re-running after an interrupted download only fetches what is missing.
 * Archives are unpacked with the system `tar` (bsdtar ships with Windows 10+, macOS
 * and every Linux), which avoids a bzip2 dependency for a one-off step.
 *
 * The manifest is src/lib/voice/speech/models.js — the same one the gateway loads
 * from, so the two cannot drift apart.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { allModelDownloads, modelsRoot } from "@/lib/voice/speech/models";

process.loadEnvFile?.(".env");

const root = modelsRoot();
mkdirSync(root, { recursive: true });

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const ATTEMPTS = 6;

/**
 * Download to `${file}.part`, RESUMING from whatever a previous attempt left there (HTTP
 * Range), retrying with backoff, and renaming to `file` only once complete — so an
 * interrupted download never looks finished, and a dropped connection at 300 MB of
 * 465 costs the remaining 165, not all of it.
 */
async function download(url, file) {
  const partial = `${file}.part`;
  let lastError;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const have = existsSync(partial) ? statSync(partial).size : 0;
    try {
      const res = await fetch(url, { redirect: "follow", headers: have ? { Range: `bytes=${have}-` } : {} });
      // 206 = the server honoured the range; 200 = it sent the whole file, start over.
      const resumed = res.status === 206;
      if (res.status === 416) {
        // Range not satisfiable: what we have is already the whole file.
        renameSync(partial, file);
        return;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const start = resumed ? have : 0;
      const total = start + Number(res.headers.get("content-length") ?? 0);
      if (resumed) console.log(`    resuming at ${mb(start)}`);

      let done = start;
      let lastPrinted = start;
      const body = Readable.fromWeb(res.body);
      body.on("data", (chunk) => {
        done += chunk.length;
        if (done - lastPrinted > 25 * 1024 * 1024 || done === total) {
          lastPrinted = done;
          process.stdout.write(`    ${mb(done)}${total ? ` / ${mb(total)}` : ""}\n`);
        }
      });
      await pipeline(body, createWriteStream(partial, { flags: resumed ? "a" : "w" }));

      if (total && statSync(partial).size !== total) throw new Error("connection closed early");
      renameSync(partial, file);
      return;
    } catch (err) {
      lastError = err;
      if (attempt === ATTEMPTS) break;
      const wait = Math.min(30, 2 ** attempt);
      console.log(`    ${err.message} — retrying in ${wait}s (attempt ${attempt + 1}/${ATTEMPTS})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(`${lastError?.message ?? "download failed"} (partial file kept — run again to resume)`);
}

let failures = 0;
for (const item of allModelDownloads()) {
  const target = path.join(root, item.target);
  if (existsSync(target)) {
    console.log(`✓ ${item.id} — already present`);
    continue;
  }

  console.log(`↓ ${item.id}`);
  try {
    if (!item.archive) {
      await download(item.url, target);
    } else {
      const archiveName = path.basename(new URL(item.url).pathname);
      const archive = path.join(root, archiveName);
      // An archive that finished downloading but never unpacked is reused, not re-fetched.
      if (!existsSync(archive)) await download(item.url, archive);
      console.log("    unpacking…");
      // Relative name + cwd, never an absolute path: GNU tar (the one Git Bash puts first
      // on PATH on Windows) reads "D:\…" as host "D", path "\…", and tries to reach it
      // over the network.
      execFileSync("tar", ["-xjf", archiveName], { cwd: root, stdio: "inherit" });
      rmSync(archive, { force: true });
      if (!existsSync(target)) throw new Error(`archive did not contain ${item.target}`);
    }
    console.log(`✓ ${item.id}`);
  } catch (err) {
    failures++;
    console.error(`✗ ${item.id}: ${err.message}`);
  }
}

console.log(failures ? `\n${failures} model(s) failed — run again to retry.` : `\nAll voice models are in ${root}`);
process.exit(failures ? 1 : 0);
