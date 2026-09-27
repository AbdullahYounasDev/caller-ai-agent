/** @type {import('next').NextConfig} */
const nextConfig = {
  /**
   * Keep the document parsers OUT of the bundle and load them from node_modules
   * as ordinary server packages.
   *
   * WHY: pdfjs resolves its own worker at runtime with a dynamic import. Bundled,
   * that path is rewritten into `.next/…/chunks/pdf.worker.mjs`, which does not
   * exist — so every PDF upload failed with "Setting up fake worker failed",
   * surfacing to the business as "we couldn't read that file" for a file that
   * was perfectly readable.
   *
   * mammoth is listed for the same class of reason: it reaches for optional
   * native and path-based dependencies that a bundler cannot see.
   *
   * @napi-rs/canvas ships a NATIVE .node binary, which a JavaScript bundler
   * cannot place at all — Turbopack fails the build outright with
   * "non-ecmascript placeable asset". tesseract.js is alongside it because it
   * resolves its worker and language data from disk at runtime, the same trap
   * pdfjs falls into.
   *
   * All four are server-only (see src/lib/agent/extract.js and ocr.js) and are
   * imported lazily, so a tenant who never uploads a scanned PDF never loads
   * the OCR stack at all.
   */
  serverExternalPackages: ["pdfjs-dist", "mammoth", "tesseract.js", "@napi-rs/canvas"],
};

export default nextConfig;
