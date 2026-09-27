import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { translator, resolveLocale } from "@/lib/i18n";
import { ingestDocument, listSources } from "@/lib/agent/ingest";
import { crawlSite, pagesToDocument } from "@/lib/agent/crawl";
import { enqueueJob } from "@/lib/agent/jobs";
import { ocrPdf } from "@/lib/agent/ocr";
import { uploadOriginalFile } from "@/lib/agent/storage";
import {
  checkFile,
  extractText,
  isEditable,
  MAX_UPLOAD_BYTES,
  ACCEPTED_EXTENSIONS,
} from "@/lib/agent/extract";

/**
 * KNOWLEDGE MANAGEMENT — what a business gives its agent to answer from.
 *
 *   GET  /api/knowledge?tenantId=…   list documents
 *   POST /api/knowledge?tenantId=…   add or REPLACE one
 *
 * POST accepts three shapes, all landing in the same ingest path because a
 * document is a document once its text is out:
 *   multipart `file` (repeatable)  uploaded pdf/docx/txt/md/csv
 *   { title, text }                typed in the dashboard
 *   { url }                        a website to crawl — see lib/agent/crawl.js
 *
 * ── UPLOADS RETURN A JOB, NOT A DOCUMENT ─────────────────────────────────
 * Reading a file and embedding it takes seconds to minutes; OCR of a scanned
 * PDF takes longer. Doing that inside the request means a connection held open
 * past every sensible proxy timeout, and a business with no idea whether
 * anything is happening. So an upload is accepted, queued, and answered with a
 * job id the dashboard follows. Typed text still returns the document directly:
 * it is small, fast, and a business that just clicked Save expects to see it.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * REPLACE, NOT APPEND. Posting a title that already exists overwrites that
 * document and re-embeds it. Uploading `prices.pdf` twice leaves one document.
 *
 * Internal-auth guarded: whatever is in here is what the agent tells that
 * business's customers is true.
 */

export const maxDuration = 300;

function uiTranslator(request) {
  return translator(
    resolveLocale({
      requested: request.nextUrl.searchParams.get("locale"),
      acceptLanguage: request.headers.get("accept-language"),
      enabled: undefined,
      fallback: undefined,
    })
  );
}

export async function GET(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tr = uiTranslator(request);
    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    const sources = await listSources(tenantId);
    return NextResponse.json({
      // `editable` is decided SERVER-side and sent with each row, so the
      // dashboard never has to re-implement the rule (and drift from it).
      sources: sources.map((s) => ({ ...s, editable: isEditable(s) })),
      limits: { maxBytes: MAX_UPLOAD_BYTES, extensions: ACCEPTED_EXTENSIONS },
    });
  } catch (err) {
    console.error("GET /api/knowledge failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tr = uiTranslator(request);
    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    const contentType = request.headers.get("content-type") ?? "";

    // AWAITED, not just returned: `return handleTypedText(...)` inside a try
    // block does NOT let this catch handle a rejection from it — an async
    // function's returned-but-unawaited promise settles after the try/catch
    // has already exited, so its rejection escapes as an unhandled promise
    // instead of reaching `catch` below. That produced exactly the empty
    // 500 body §6.12 warns about: a genuine, expected failure (a too-large
    // document, say) never got formatted as JSON at all.
    if (contentType.includes("multipart/form-data")) {
      return await handleUploads({ request, tenantId, tr });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }

    if (body.url) return await handleCrawl({ body, tenantId, tr });
    return await handleTypedText({ body, tenantId, tr });
  } catch (err) {
    console.error("POST /api/knowledge failed:", err);
    return NextResponse.json(
      { error: err?.message ?? "Something went wrong" },
      { status: 500 }
    );
  }
}

/**
 * MANY FILES AT ONCE.
 *
 * Each file becomes its OWN job. A ten-file upload where the third is corrupt
 * should import the other nine and report that one failure — not abort the
 * batch. Per-file jobs also give per-file progress, which is what a business
 * watching an import actually wants to see.
 *
 * Files are read into memory HERE, before queueing, because the request body is
 * gone once this handler returns and the job runs after that.
 */
async function handleUploads({ request, tenantId, tr }) {
  const form = await request.formData();
  const files = form.getAll("file").filter((f) => f && typeof f !== "string");

  if (!files.length) {
    return NextResponse.json({ error: tr("validation:file.required") }, { status: 400 });
  }

  const accepted = [];
  const rejected = [];

  for (const uploaded of files) {
    const verdict = checkFile({
      fileName: uploaded.name,
      mimeType: uploaded.type,
      byteSize: uploaded.size,
    });

    if (!verdict.ok) {
      const [key, detail] = verdict.reason.split(":");
      rejected.push({
        fileName: uploaded.name,
        error: tr(`validation:file.${key}`, {
          vars: {
            types: detail ?? ACCEPTED_EXTENSIONS.join(" "),
            max: Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)),
          },
        }),
      });
      continue;
    }

    const buffer = await uploaded.arrayBuffer();
    const title = uploaded.name;

    const job = await enqueueJob({
      tenantId,
      title,
      kind: "file",
      fileName: uploaded.name,
      byteSize: uploaded.size,
      run: async (ctx) => {
        await ctx.report("extracting", 0, 1);
        let extracted = await extractText({ buffer, fileName: uploaded.name });

        // A SCANNED PDF — images, no text layer. This is the case background
        // jobs were built for: OCR is seconds per page and cannot happen
        // inside a request.
        if (!extracted.ok && extracted.reason === "scanned") {
          await ctx.report("ocr", 0, extracted.pageCount || 1);
          const ocr = await ocrPdf({
            buffer,
            onProgress: (done, total) => ctx.report("ocr", done, total),
          });
          if (!ocr.ok) throw new Error(tr(`validation:file.${ocr.reason}`));
          extracted = { ok: true, text: ocr.text };
        }

        if (!extracted.ok) throw new Error(tr(`validation:file.${extracted.reason}`));

        // Keep the ORIGINAL file (Cloudinary) so it can be deleted alongside the
        // document later and, eventually, downloaded — ingestDocument itself
        // only ever sees extracted text. Best-effort: uploadOriginalFile
        // returns null rather than throwing on any failure, so a Cloudinary
        // outage never fails an otherwise-successful import.
        const stored = await uploadOriginalFile({
          buffer,
          fileName: uploaded.name,
          tenantId,
        });

        return ingestDocument({
          tenantId,
          title,
          text: extracted.text,
          kind: "file",
          file: {
            fileName: uploaded.name,
            mimeType: uploaded.type,
            byteSize: uploaded.size,
            fileUrl: stored?.url,
            filePublicId: stored?.publicId,
          },
          onProgress: (stage, done, total) => ctx.report(stage, done, total),
          onSource: (sourceId) => ctx.attachSource(sourceId),
        });
      },
    });

    accepted.push({ id: job.id, title, fileName: uploaded.name });
  }

  // 202: accepted for processing, not finished. The dashboard follows the jobs.
  return NextResponse.json({ jobs: accepted, rejected }, { status: accepted.length ? 202 : 400 });
}

/** A crawl is also slow — several page fetches plus embedding — so it queues too. */
async function handleCrawl({ body, tenantId, tr }) {
  const startUrl = String(body.url);
  let host;
  try {
    host = new URL(startUrl).host;
  } catch {
    return NextResponse.json({ error: tr("validation:url.invalidUrl") }, { status: 400 });
  }

  const title = String(body.title || "").trim() || host;

  const job = await enqueueJob({
    tenantId,
    title,
    kind: "url",
    fileName: startUrl,
    run: async (ctx) => {
      await ctx.report("extracting", 0, 1);
      const crawled = await crawlSite({
        startUrl,
        maxPages: Number(body.maxPages) || 10,
        followLinks: body.followLinks !== false,
        onProgress: (done, total) => ctx.report("extracting", done, total),
      });
      if (!crawled.ok) {
        throw new Error(
          tr(`validation:url.${crawled.reason}`, { vars: { status: crawled.status ?? "" } })
        );
      }

      return ingestDocument({
        tenantId,
        title,
        text: pagesToDocument(crawled.pages),
        kind: "url",
        file: { fileName: startUrl },
        onProgress: (stage, done, total) => ctx.report(stage, done, total),
        onSource: (sourceId) => ctx.attachSource(sourceId),
      });
    },
  });

  return NextResponse.json({ jobs: [{ id: job.id, title }], rejected: [] }, { status: 202 });
}

/** Typed text is small and fast, so it stays synchronous — someone who just
 *  clicked Save expects the document to be there when the button releases. */
async function handleTypedText({ body, tenantId, tr }) {
  const title = String(body.title ?? "").trim();
  const text = String(body.text ?? "");

  if (!title) {
    return NextResponse.json({ error: tr("validation:document.titleRequired") }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ error: tr("validation:document.textRequired") }, { status: 400 });
  }

  const result = await ingestDocument({ tenantId, title, text, kind: "text" });
  return NextResponse.json({ document: result }, { status: result.replaced ? 200 : 201 });
}
