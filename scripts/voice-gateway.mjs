#!/usr/bin/env node
/**
 * Start the voice gateway (npm run voice). Everything lives in src/lib/voice/gateway.js;
 * this file only loads .env, starts it, and turns Ctrl+C / SIGTERM into a clean shutdown
 * that ends every live call and writes its record before the process exits.
 *
 * .env is loaded BEFORE the gateway is imported, deliberately with a dynamic import:
 * static imports are hoisted, and some modules read their env at import time
 * (gemini.js's GEMINI_CHAT_MODEL) — they would see an empty environment.
 */
process.loadEnvFile?.(".env");

const { startVoiceGateway } = await import("@/lib/voice/gateway");
const gateway = await startVoiceGateway();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await gateway.stop();
    process.exit(0);
  });
}
