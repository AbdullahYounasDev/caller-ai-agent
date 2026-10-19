import { JobCancelledError } from "./jobs";

/**
 * OCR FOR SCANNED PDFs.
 *
 * A scanned document is pages of IMAGES with no text layer. Businesses have
 * plenty of them — a price list photocopied years ago, a policy someone scanned
 * and never retyped — and until now those uploaded "successfully" and taught the
 * agent nothing, or were rejected with "we couldn't find any text".
 *
 * The pipeline is: render each PDF page to a bitmap with pdfjs, then read the
 * characters out of that bitmap with Tesseract.
 *
 * ── THIS IS SLOW, AND THAT IS WHY BACKGROUND JOBS EXIST ──────────────────
 * Seconds per page, and a worker that takes several seconds to start. A ten-page
 * scan is comfortably past any sensible HTTP timeout, which is exactly the case
 * lib/agent/jobs.js was built for. Every page reports progress, because a bar
 * that moves is the difference between "working" and "broken" to the person
 * watching it.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Rendering scale. OCR accuracy depends heavily on resolution: at 1x a 10pt
 * font is too few pixels per character to read reliably, and accuracy collapses.
 * 2x (roughly 150 DPI) is the point where accuracy plateaus — past it the images
 * get large and slow without reading any better.
 */
const RENDER_SCALE = 2;

/** Pages beyond this are not OCR'd. A 200-page scan would take many minutes and
 *  is almost certainly not what anyone meant to put in a chat agent's knowledge
 *  base; the pages that ARE read still produce a usable document. */
const MAX_OCR_PAGES = 30;

/**
 * Both active languages (§7). Tesseract needs the traineddata for each and downloads
 * it on first use (cached next to the process — eng.traineddata is in the repo root,
 * urd.traineddata appears there after the first Urdu scan and is git-ignored), which is
 * most of why the first OCR is slow. Passing both lets one document contain both
 * languages, as Pakistani business documents routinely do. Urdu OCR is noticeably less
 * accurate than English; a scanned Urdu document is worth re-uploading as a text PDF.
 */
const OCR_LANGUAGES = "eng+urd";

/**
 * Does this PDF need OCR?
 *
 * The test is characters-per-page, not "is the text empty". Scanned PDFs are
 * rarely completely bare: they often carry a stray header, a page number, or a
 * few words of junk from a failed text layer. A genuine text PDF yields
 * hundreds of characters per page, so the two are far apart and the threshold
 * does not need to be delicate.
 *
 * @param {string} text  what normal extraction produced
 * @param {number} pageCount
 */
export function looksScanned(text, pageCount) {
  if (pageCount <= 0) return false;
  const perPage = String(text ?? "").trim().length / pageCount;
  return perPage < 80;
}

/**
 * Render one PDF page to a PNG buffer.
 *
 * pdfjs needs a canvas to draw into, which does not exist in Node — hence
 * @napi-rs/canvas, a native implementation. It is only ever loaded when a
 * scanned PDF actually arrives, so ordinary text PDFs never pay for it.
 */
async function renderPage(page, createCanvas) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");

  // White background first. A transparent canvas renders black-on-black once
  // flattened to PNG, and Tesseract reads exactly nothing from it.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: context, viewport, background: "#ffffff" }).promise;
  return canvas.toBuffer("image/png");
}

/**
 * OCR a scanned PDF.
 *
 * @param {object} args
 * @param {ArrayBuffer} args.buffer
 * @param {(done: number, total: number) => Promise<void>|void} [args.onProgress]
 * @returns {Promise<{ok: true, text: string, pages: number, truncated: boolean}
 *                 | {ok: false, reason: string}>}
 */
export async function ocrPdf({ buffer, onProgress }) {
  let worker;
  let loadingTask;

  try {
    const [{ createCanvas }, tesseractModule, pdfjs] = await Promise.all([
      import("@napi-rs/canvas"),
      import("tesseract.js"),
      import("pdfjs-dist/legacy/build/pdf.mjs"),
    ]);
    const createWorker = tesseractModule.createWorker ?? tesseractModule.default?.createWorker;

    loadingTask = pdfjs.getDocument({
      // A COPY, not a view. pdfjs TRANSFERS the buffer it is handed to its
      // internal worker, which DETACHES the original — so the SECOND reader of
      // the same upload finds an empty husk and throws "Construct on a detached
      // ArrayBuffer". That is exactly the path a scanned PDF takes: text
      // extraction first, then OCR on the same bytes.
      data: new Uint8Array(buffer.slice(0)),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const doc = await loadingTask.promise;

    const total = Math.min(doc.numPages, MAX_OCR_PAGES);
    const truncated = doc.numPages > MAX_OCR_PAGES;

    // Started AFTER the PDF opens, so a corrupt file fails before paying the
    // several seconds it takes to spin a worker up.
    worker = await createWorker(OCR_LANGUAGES);

    const pages = [];
    for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const png = await renderPage(page, createCanvas);
      page.cleanup();

      const { data } = await worker.recognize(png);
      const pageText = String(data?.text ?? "").trim();
      if (pageText) pages.push(pageText);

      // Reported AFTER the page, so the number shown is work actually finished.
      await onProgress?.(pageNumber, total);
    }

    const text = normalizeOcrText(pages.join("\n\n"));
    if (!text) return { ok: false, reason: "noText" };

    return { ok: true, text, pages: total, truncated };
  } catch (err) {
    // A cancelled job throws THIS from inside onProgress (see jobs.js
    // JobContext.report), called once per page via the loop above. It must
    // propagate to the caller, not be reported as an ordinary OCR failure —
    // swallowing it here would have the job fail with "unreadable" instead of
    // being recognised and cleaned up as a cancellation.
    if (err instanceof JobCancelledError) throw err;
    console.error("ocrPdf failed:", err);
    return { ok: false, reason: "unreadable" };
  } finally {
    // Both hold native resources. Leaking a Tesseract worker per upload would
    // exhaust the process within a day of ordinary use.
    await worker?.terminate?.().catch(() => {});
    await loadingTask?.destroy?.().catch(() => {});
  }
}

/**
 * Tidy OCR output.
 *
 * OCR produces characteristic noise that ordinary text never has: a scanline
 * misread as a row of punctuation, a speck of dust as a stray character on its
 * own line. Left in, those become chunks that match nothing and dilute the ones
 * that matter.
 */
function normalizeOcrText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    // Drop lines that are only punctuation or a single stray character — the
    // usual residue of scan artefacts.
    .filter((line) => line.length > 1 && /[\p{L}\p{N}]/u.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const OCR_LIMITS = { maxPages: MAX_OCR_PAGES, languages: OCR_LANGUAGES };
