import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkInternalAuth } from "@/lib/auth/internal";
import { deleteRecording, readRecording } from "@/lib/standins/recordings";

/**
 * A CALL'S RECORDING (CLAUDE.md §6.30) — the stereo WAV of a phone call whose agent had recording on:
 * the caller on the left channel, the agent on the right.
 *
 *   GET    /api/voice/calls/:id/recording?tenantId=…     → audio/wav
 *   DELETE /api/voice/calls/:id/recording?tenantId=…     → { deleted: true } — the file and the pointer to it
 *
 * Internal-key guarded and scoped by tenant AND call id: one business can neither hear nor delete another's
 * call by guessing an id. A GET is not gated on serviceability (reading one's own history, §6.18) and neither is
 * the DELETE — taking someone's data away is never what a suspension should block.
 *
 * STAND-IN: where recordings live, how long they are kept and who may hear them is the backend's (handoff
 * B11c); this route reads standins/recordings.js and is replaced with a redirect to his storage.
 */
async function findCall(request, context) {
  const auth = checkInternalAuth(request);
  if (!auth.ok) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  const tenantId = request.nextUrl.searchParams.get("tenantId");
  if (!tenantId) return { response: NextResponse.json({ error: "tenantId is required" }, { status: 400 }) };
  // In this Next.js, dynamic route params are async and must be awaited.
  const { id } = await context.params;
  const call = await prisma.callLog.findFirst({ where: { id, tenantId }, select: { id: true, tenantId: true, recordingUrl: true } });
  if (!call) return { response: NextResponse.json({ error: "Call not found" }, { status: 404 }) };
  return { call };
}

export async function GET(request, context) {
  try {
    const found = await findCall(request, context);
    if (found.response) return found.response;
    const wav = found.call.recordingUrl ? await readRecording({ tenantId: found.call.tenantId, callId: found.call.id }) : null;
    if (!wav) return NextResponse.json({ error: "This call has no recording" }, { status: 404 });
    return new Response(wav, {
      status: 200,
      headers: {
        "content-type": "audio/wav",
        "content-length": String(wav.length),
        "content-disposition": `inline; filename="call-${found.call.id}.wav"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("GET /api/voice/calls/[id]/recording failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export async function DELETE(request, context) {
  try {
    const found = await findCall(request, context);
    if (found.response) return found.response;
    if (!found.call.recordingUrl) return NextResponse.json({ error: "This call has no recording" }, { status: 404 });
    await deleteRecording({ tenantId: found.call.tenantId, callId: found.call.id });
    await prisma.callLog.update({ where: { id: found.call.id }, data: { recordingUrl: null } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("DELETE /api/voice/calls/[id]/recording failed:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
