import { NextResponse } from "next/server";
import { checkInternalAuth } from "@/lib/auth/internal";
import { translator, resolveLocale } from "@/lib/i18n";
import { requireServiceableTenant } from "@/lib/tenant/registry";
import { isEditable } from "@/lib/agent/extract";
import {
  getSource,
  renameSource,
  deleteSource,
  ingestDocument,
} from "@/lib/agent/ingest";

/**
 * ONE DOCUMENT.
 *
 *   GET    /api/knowledge/:id   read it back, including its full text
 *   PUT    /api/knowledge/:id   edit the text and/or rename it
 *   DELETE /api/knowledge/:id   remove it and everything derived from it
 *
 * GET returning the original text is what makes editing possible: a business
 * opens what it wrote, changes the price that was wrong, and saves. Chunks are
 * derived data and are rebuilt from this text on every save.
 *
 * Every handler is scoped by `tenantId` as well as `id` inside lib/agent/ingest,
 * so one tenant can never touch another's document by guessing a uuid.
 */

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

/** In this Next.js, dynamic route params are async and must be awaited. */
async function routeId(context) {
  const params = await context.params;
  return params.id;
}

export async function GET(request, context) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tr = uiTranslator(request);
    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    const source = await getSource({ tenantId, id: await routeId(context) });
    if (!source) {
      return NextResponse.json({ error: tr("validation:document.notFound") }, { status: 404 });
    }

    return NextResponse.json({ document: source });
  } catch (err) {
    console.error("GET /api/knowledge/[id] failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function PUT(request, context) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tr = uiTranslator(request);
    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    // Mutates the tenant's knowledge — see the shared check's doc comment
    // (registry.js) for why this lives here instead of a bespoke branch.
    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) {
      return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });
    }

    const id = await routeId(context);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: tr("validation:body.invalid") }, { status: 400 });
    }

    const existing = await getSource({ tenantId, id });
    if (!existing) {
      return NextResponse.json({ error: tr("validation:document.notFound") }, { status: 404 });
    }

    // ENFORCE THE EDITABILITY RULE SERVER-SIDE. The dashboard hides the edit
    // button for uploaded PDFs and Word files, but a hidden button is not a
    // permission check — and editing one would overwrite the document with our
    // lossy extraction of it while still labelling it as that file.
    // Renaming stays allowed: a title is ours, not the file's.
    const wantsTextChange =
      body.text !== undefined && String(body.text) !== existing.content;
    if (wantsTextChange && !isEditable(existing)) {
      return NextResponse.json(
        { error: tr("validation:document.notEditable") },
        { status: 409 }
      );
    }

    const nextTitle = String(body.title ?? existing.title).trim();
    const nextText = body.text === undefined ? existing.content : String(body.text);

    if (!nextTitle) {
      return NextResponse.json({ error: tr("validation:document.titleRequired") }, { status: 400 });
    }
    if (!nextText.trim()) {
      return NextResponse.json({ error: tr("validation:document.textRequired") }, { status: 400 });
    }

    const textChanged = nextText !== existing.content;

    // A RENAME ALONE DOES NOT RE-EMBED. Re-running the whole pipeline to change
    // a label would spend model quota to produce byte-identical vectors. The
    // title is only denormalised onto the chunks so retrieval can cite it, and
    // renameSource rewrites exactly that.
    if (!textChanged) {
      if (nextTitle === existing.title) {
        return NextResponse.json({ document: existing, reembedded: false });
      }
      try {
        const renamed = await renameSource({ tenantId, id, title: nextTitle });
        return NextResponse.json({ document: renamed, reembedded: false });
      } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
    }

    // The text changed, so the chunks are stale — ingest replaces them.
    // Renaming at the same time is handled first so the new chunks are written
    // with the new title rather than being rewritten straight afterwards.
    if (nextTitle !== existing.title) {
      try {
        await renameSource({ tenantId, id, title: nextTitle });
      } catch (err) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
    }

    const result = await ingestDocument({
      tenantId,
      title: nextTitle,
      text: nextText,
      // An edited upload becomes typed text: what is stored is now what the
      // business wrote, not what the file contained, and claiming otherwise
      // would misreport where the content came from.
      kind: existing.kind === "file" && textChanged ? "text" : existing.kind,
    });

    return NextResponse.json({ document: result, reembedded: true });
  } catch (err) {
    console.error("PUT /api/knowledge/[id] failed:", err);
    return NextResponse.json(
      { error: err?.message ?? "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(request, context) {
  try {
    const auth = checkInternalAuth(request);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tr = uiTranslator(request);
    const tenantId = request.nextUrl.searchParams.get("tenantId");
    if (!tenantId) {
      return NextResponse.json({ error: tr("validation:tenantId.required") }, { status: 400 });
    }

    const serviceable = await requireServiceableTenant({ tenantId, tr });
    if (!serviceable.ok) {
      return NextResponse.json({ error: serviceable.error }, { status: serviceable.status });
    }

    const removed = await deleteSource({ tenantId, id: await routeId(context) });
    if (!removed) {
      return NextResponse.json({ error: tr("validation:document.notFound") }, { status: 404 });
    }

    return NextResponse.json({ deleted: removed });
  } catch (err) {
    console.error("DELETE /api/knowledge/[id] failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
