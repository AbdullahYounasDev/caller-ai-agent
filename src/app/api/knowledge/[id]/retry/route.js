import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { translator, resolveLocale } from "@/lib/i18n";
import { getSource, retrySource } from "@/lib/agent/ingest";
import { enqueueJob } from "@/lib/agent/jobs";

/**
 * RETRY A FAILED IMPORT.
 *
 *   POST /api/knowledge/:id/retry?tenantId=…   → 202, { job }
 *
 * Only meaningful for a document whose LAST attempt failed — usually a
 * transient provider error (quota, an outage), never something retrying will
 * fix on its own (a document that is genuinely too large stays too large).
 * The dashboard is expected to only show "Try again" for the transient kind
 * (see humanizeError on the client), but this route re-checks status itself
 * rather than trusting that.
 *
 * Queued as a background job for the same reason every other embed-heavy
 * import is: it can take longer than a request should stay open. It does NOT
 * re-read an uploaded file or re-hit Cloudinary — lib/agent/ingest.js's
 * retrySource() re-embeds the text and Cloudinary reference already sitting
 * on the row.
 */

async function routeId(context) {
  const params = await context.params;
  return params.id;
}

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

export async function POST(request, context) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tr = uiTranslator(request);
    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    const id = await routeId(context);
    const source = await getSource({ tenantId, id });
    if (!source) {
      return NextResponse.json({ error: tr("validation:document.notFound") }, { status: 404 });
    }
    if (source.status !== "failed") {
      return NextResponse.json(
        { error: tr("validation:document.notFailed") },
        { status: 409 }
      );
    }

    const job = await enqueueJob({
      tenantId,
      title: source.title,
      kind: source.kind,
      fileName: source.fileName,
      byteSize: source.byteSize,
      run: (ctx) =>
        retrySource({
          tenantId,
          id,
          onProgress: (stage, done, total) => ctx.report(stage, done, total),
          onSource: (sourceId) => ctx.attachSource(sourceId),
        }),
    });

    return NextResponse.json({ job }, { status: 202 });
  } catch (err) {
    console.error("POST /api/knowledge/[id]/retry failed:", err);
    return NextResponse.json(
      { error: err?.message ?? "Something went wrong" },
      { status: 500 }
    );
  }
}
