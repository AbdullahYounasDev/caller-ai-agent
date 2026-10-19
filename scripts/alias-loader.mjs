/**
 * Node module-resolution hook so a plain `node` script can import code from
 * `src/` the way the app does: the `@/` alias, extensionless relative imports,
 * and JSON imports (the i18n catalogs). Next/Turbopack resolves all three for the
 * app; bare Node does none of them.
 *
 * Used by scripts that must run the SAME ingest/chunk/embed code as the app
 * rather than a copy of it (scripts/reembed.mjs) — a copy is how the re-embed
 * and the live ingest would drift into embedding documents two different ways.
 * Registered by scripts/alias-register.mjs; not for production code.
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SRC = path.resolve("src");

// Test seam: scripts/test-reembed-register.mjs and scripts/test-collect-register.mjs pass
// { stubLlm: <file URL> } so the ingest / retrieval / reply code runs against a fake model
// (no quota spent). Absent in every real run.
let stubLlm = null;
export function initialize(data) {
  stubLlm = data?.stubLlm ?? null;
}

function tryResolve(base) {
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return null;
}

function resolved(url) {
  return {
    url,
    shortCircuit: true,
    ...(url.endsWith(".json") ? { importAttributes: { type: "json" } } : {}),
  };
}

export async function resolve(specifier, context, next) {
  const LLM_USERS = ["/ingest.js", "/retrieve.js", "/respond.js", "/query.js"];
  if (stubLlm && specifier === "./llm" && LLM_USERS.some((file) => context.parentURL?.endsWith(file))) {
    return { url: stubLlm, shortCircuit: true };
  }
  if (specifier.startsWith("@/")) {
    const url = tryResolve(path.join(SRC, specifier.slice(2)));
    if (url) return resolved(url);
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const url = tryResolve(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
    if (url) return resolved(url);
  }
  return next(specifier, context);
}
