#!/usr/bin/env node
/**
 * VOICE SMOKE TEST + BENCHMARK (npm run voice:smoke) — proves the speech pipeline works
 * on THIS machine and measures it, with no microphone and no person.
 *
 *   npm run voice:smoke
 *     Speech models only. ZERO quota: no LLM, no embedding, no database.
 *     For English and Italian: Piper speaks a sentence → Parakeet transcribes it back,
 *     at 16 kHz and again through SIMULATED PHONE AUDIO (8 kHz, the band a Twilio call
 *     carries, §9.2) → accuracy and the time each stage took. Then the VAD is run over
 *     the audio padded with silence, to check it finds exactly one utterance.
 *
 *   npm run voice:smoke -- --call [--tenant=test-tenant] [--say="What are your opening hours?"] [--lang=en]
 *     A REAL call through the running app + gateway (`npm run dev` and `npm run voice`),
 *     with a synthesised caller: gets a ticket, dials, waits out the greeting, "speaks"
 *     the question in real time, and reports the transcript, the reply, the turn's intent
 *     and outcome, and end-of-speech → first-audio latency measured at the caller's end.
 *     SPENDS QUOTA: one chat request and one embedding per run (§8 limitation 3).
 */
process.loadEnvFile?.(".env");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : true];
  })
);

const { loadLocalSpeech } = await import("@/lib/voice/speech/engine");
const { createSpeechToText } = await import("@/lib/voice/speech/stt");
const { createTextToSpeech } = await import("@/lib/voice/speech/tts");
const { VoiceActivity } = await import("@/lib/voice/speech/vad");

const loadStarted = performance.now();
const engine = await loadLocalSpeech();
// The LOCAL recogniser on purpose: this benchmark measures the models on this machine.
const stt = createSpeechToText({ engine, env: { VOICE_STT_PROVIDER: "local" } }).forCall({ replyLanguage: "en" });
const tts = createTextToSpeech({ engine });
console.log(`models loaded in ${ms(performance.now() - loadStarted)} — ${engine.info.runtime}\n`);

const resample = (samples, from, to) => new engine.sherpa.LinearResampler(from, to).flush(samples);

if (args.call) await realCall();
else await benchmark();
process.exit(0);

// ─────────────────────────────────────────────────────────────────────────────

async function benchmark() {
  const sentences = {
    en: [
      "What are your opening hours on Saturday?",
      "How much does the Pro plan cost per month, and is support included?",
    ],
    it: [
      "Quali sono i vostri orari di apertura il sabato?",
      "Quanto costa il piano Pro al mese, e l'assistenza è inclusa?",
    ],
  };

  // Both voice tiers (voices.js): the natural default and a fast Piper voice per language.
  const voicesByLanguage = {
    en: ["kokoro:af_heart", "piper:en_US-lessac-medium"],
    it: ["kokoro:if_sara", "piper:it_IT-paola-medium"],
  };

  const rows = [];
  for (const [language, list] of Object.entries(sentences)) {
    for (const voiceId of voicesByLanguage[language]) {
      for (const text of list) {
        const voice = await tts.synthesize({ text, voiceId });
        const audioMs = (voice.samples.length / voice.sampleRate) * 1000;
        const wide = resample(voice.samples, voice.sampleRate, 16_000);
        // Phone line: down to 8 kHz (everything above 4 kHz is gone), back up to 16 kHz.
        const phone = resample(resample(voice.samples, voice.sampleRate, 8_000), 8_000, 16_000);

        const a = await stt.transcribe(wide);
        const b = await stt.transcribe(phone);
        rows.push({
          language,
          voiceId,
          text,
          ttsMs: voice.ms,
          audioMs,
          wide: { ...a, wer: wordErrorRate(text, a.text) },
          phone: { ...b, wer: wordErrorRate(text, b.text) },
        });
      }
    }
  }

  // Urdu: synthesis speed only — there is no local Urdu recogniser to check it with
  // (speech/stt.js). Its intelligibility was checked separately (§6.24).
  for (const voiceId of ["kokoro:hf_alpha", "kokoro:hm_omega"]) {
    const text = "ہمارے سپورٹ کے اوقات پیر سے جمعہ، صبح نو بجے سے شام چھ بجے تک ہیں۔";
    const voice = await tts.synthesize({ text, voiceId });
    const audioMs = (voice.samples.length / voice.sampleRate) * 1000;
    console.log(`[ur ${voiceId}] TTS ${ms(voice.ms)} for ${ms(audioMs)} of speech (${(voice.ms / audioMs).toFixed(2)}× real time)`);
  }
  console.log();

  for (const r of rows) {
    console.log(`[${r.language} ${r.voiceId}] "${r.text}"`);
    console.log(`  TTS   ${ms(r.ttsMs)} for ${ms(r.audioMs)} of speech  (${(r.ttsMs / r.audioMs).toFixed(2)}× real time)`);
    console.log(`  STT   16 kHz  ${ms(r.wide.ms)}  WER ${pct(r.wide.wer)}  → "${r.wide.text}"`);
    console.log(`  STT   phone   ${ms(r.phone.ms)}  WER ${pct(r.phone.wer)}  → "${r.phone.text}"\n`);
  }

  // VAD: half a second of silence, the utterance, a second of silence → exactly one segment.
  const voice = await tts.synthesize({ text: sentences.en[0], language: "en" });
  const speech = resample(voice.samples, voice.sampleRate, 16_000);
  const padded = new Float32Array(8_000 + speech.length + 16_000);
  padded.set(speech, 8_000);
  const vad = new VoiceActivity({ sherpa: engine.sherpa, config: engine.vadConfig });
  const events = [];
  for (let i = 0; i < padded.length; i += 320) events.push(...vad.push(padded.subarray(i, i + 320)));
  const utterances = events.filter((e) => e.type === "utterance");
  console.log(
    `VAD   ${utterances.length} utterance(s) found in ${ms((padded.length / 16_000) * 1000)} of audio` +
      (utterances.length ? `, ${ms(utterances[0].durationMs)} long (speech was ${ms((speech.length / 16_000) * 1000)})` : "")
  );

  const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
  for (const tier of ["kokoro", "piper"]) {
    const t = rows.filter((r) => r.voiceId.startsWith(tier));
    console.log(
      `\nSUMMARY ${tier.padEnd(6)}  TTS avg ${ms(avg(t.map((r) => r.ttsMs)))} per sentence (${(avg(t.map((r) => r.ttsMs / r.audioMs))).toFixed(2)}× real time)` +
        ` · WER 16 kHz ${pct(avg(t.map((r) => r.wide.wer)))} · WER phone ${pct(avg(t.map((r) => r.phone.wer)))}`
    );
  }
  console.log(`STT avg ${ms(avg(rows.map((r) => r.wide.ms)))} per utterance`);
  if (utterances.length !== 1) process.exitCode = 1;
}

async function realCall() {
  const { WebSocket } = await import("ws");
  const { CLIENT, SERVER } = await import("@/lib/voice/protocol");
  const { float32ToPcm16 } = await import("@/lib/voice/audio");
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const tenantId = args.tenant || process.env.TEST_TENANT || "test-tenant";
  const say = args.say || "What are your opening hours?";
  const language = args.lang === "it" ? "it" : "en";

  const res = await fetch(`${appUrl}/api/voice/session?tenantId=${encodeURIComponent(tenantId)}`, {
    method: "POST",
    headers: process.env.INTERNAL_API_KEY ? { "x-internal-key": process.env.INTERNAL_API_KEY } : {},
  });
  const session = await res.json();
  if (!res.ok) throw new Error(`session: ${res.status} ${JSON.stringify(session)}`);

  const question = await tts.synthesize({ text: say, language });
  const pcm = resample(question.samples, question.sampleRate, 16_000);

  const ws = new WebSocket(session.url);
  const log = (...a) => console.log(`+${((performance.now() - t0) / 1000).toFixed(2)}s`, ...a);
  const t0 = performance.now();
  let audioRate = 22_050;
  let greetingAudioMs = 0;
  let phase = "greeting";
  let speechEndedAt = null;
  let firstReplyAudioAt = null;
  let summary = null;
  let playbackEndsAt = null;
  const gaps = [];

  const done = new Promise((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: CLIENT.HELLO, ticket: session.ticket })));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const audioMs = (data.length / 2 / audioRate) * 1000;
        if (phase === "greeting") greetingAudioMs += audioMs;
        else if (speechEndedAt != null) {
          const now = performance.now();
          if (firstReplyAudioAt == null) firstReplyAudioAt = now;
          // Simulate the caller's playback queue: a chunk plays at max(arrival, end of the
          // previous one). Silence BETWEEN chunks of one reply is the "agent stalled
          // mid-sentence" failure progressive chunking exists to prevent.
          if (playbackEndsAt != null && now > playbackEndsAt) {
            gaps.push(Math.round(now - playbackEndsAt));
          }
          playbackEndsAt = Math.max(now, playbackEndsAt ?? now) + audioMs;
        }
        return;
      }
      const m = JSON.parse(String(data));
      if (m.type === SERVER.AUDIO_FORMAT) audioRate = m.sampleRate;
      else if (m.type === SERVER.READY) log(`answered — call ${m.callId}`);
      else if (m.type === SERVER.AGENT_TEXT) log(`agent: ${m.text}`);
      else if (m.type === SERVER.TRANSCRIPT) log(`heard: "${m.text}"  (STT ${m.sttMs} ms)`);
      else if (m.type === SERVER.ERROR) log(`error: ${m.code} ${m.message}`);
      else if (m.type === SERVER.TURN) {
        summary = m;
        ws.send(JSON.stringify({ type: CLIENT.HANGUP }));
      } else if (m.type === SERVER.ENDED) log(`ended: ${m.reason}`);
    });
    ws.on("close", resolve);
    ws.on("error", reject);
  });

  // Let the greeting "play" (we never report playback, so the gateway uses its own
  // estimate of when it ends), then speak in real time, 20 ms per frame.
  await waitFor(() => greetingAudioMs > 0, 15_000);
  await sleep(500);
  await sleep(greetingAudioMs + 400);
  phase = "question";
  log(`caller says: "${say}"`);
  const silence = new Float32Array(16_000); // trailing second of silence ends the turn
  const all = new Float32Array(pcm.length + silence.length);
  all.set(pcm);
  for (let i = 0, next = performance.now(); i < all.length; i += 320) {
    if (i >= pcm.length && speechEndedAt == null) speechEndedAt = performance.now();
    ws.send(float32ToPcm16(all.subarray(i, i + 320)));
    next += 20;
    await sleep(Math.max(0, next - performance.now()));
  }

  await done;
  if (!summary) throw new Error("no turn completed");
  const t = summary.timings;
  console.log(`\nintent ${summary.intent} · outcome ${summary.outcome} · sources ${summary.sources.join(", ") || "none"} · model ${summary.model}`);
  console.log(
    `stages: STT ${t.sttMs} · retrieval ${t.retrievalMs} (rewrite ${t.rewriteMs ?? "-"}) · first token ${t.llmFirstTokenMs} · TTS ${t.ttsFirstAudioMs} ms`
  );
  console.log(`gateway: end-of-speech → first audio ${t.responseMs} ms (after the VAD's silence window)`);
  if (firstReplyAudioAt && speechEndedAt) {
    console.log(`caller:  last word → first reply audio ${Math.round(firstReplyAudioAt - speechEndedAt)} ms (what a caller would feel)`);
  }
  console.log(
    gaps.length
      ? `playback: ${gaps.length} silent gap(s) mid-reply — ${gaps.map((g) => `${g} ms`).join(", ")}`
      : "playback: no silent gaps mid-reply"
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function wordErrorRate(reference, hypothesis) {
  const words = (s) => s.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}']+/gu) ?? [];
  const r = words(reference);
  const h = words(hypothesis);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return r.length ? d[r.length][h.length] / r.length : 0;
}

function ms(v) {
  return `${Math.round(v)} ms`;
}
function pct(v) {
  return `${(v * 100).toFixed(0)}%`;
}
function sleep(t) {
  return new Promise((r) => setTimeout(r, t));
}
async function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out waiting for the gateway");
    await sleep(20);
  }
}
