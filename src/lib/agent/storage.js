import { v2 as cloudinary } from "cloudinary";

/**
 * ORIGINAL FILE STORAGE (Cloudinary).
 *
 * Only the original bytes of an uploaded document live here — what the agent
 * actually answers from is `knowledge_sources.content`, the plain text
 * lib/agent/extract.js pulled out of it. This exists purely so a business can
 * get its original PDF/Word file back, and so deleting or replacing a document
 * also removes the copy sitting in Cloudinary instead of leaving it there
 * forever as an orphan nobody can see or clean up.
 *
 * BEST-EFFORT ON PURPOSE. This is not the RAG pipeline: a Cloudinary outage on
 * upload must not fail an otherwise-successful import, and a failed delete
 * must not block removing the document or its vector data. Postgres is the
 * source of truth for whether a document and its chunks exist; Cloudinary
 * never is. Every function here swallows its own errors and returns a value
 * the caller can treat as "no original available" rather than throwing.
 */

let configured = false;

function isConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

function ensureConfigured() {
  if (configured) return;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  configured = true;
}

/**
 * Upload an uploaded document's original bytes to Cloudinary.
 *
 * @param {object} args
 * @param {ArrayBuffer} args.buffer
 * @param {string} args.fileName
 * @param {string} args.tenantId
 * @returns {Promise<{url: string, publicId: string} | null>} null when
 *   Cloudinary isn't configured or the upload failed — callers must treat the
 *   original file as optional, never as a requirement for ingest to succeed.
 */
export function uploadOriginalFile({ buffer, fileName, tenantId }) {
  if (!isConfigured()) {
    console.warn("[storage] CLOUDINARY_* env vars not set — skipping original-file upload");
    return Promise.resolve(null);
  }
  ensureConfigured();

  return new Promise((resolve) => {
    // resource_type "raw": these are documents (PDF/DOCX/TXT/…), not images or
    // video — Cloudinary's default pipeline would otherwise try to transcode
    // them. unique_filename lets the same filename be uploaded again (a
    // replace) without colliding with the asset it is about to replace.
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw",
        folder: `caller-ai-agent/${tenantId}`,
        filename_override: fileName,
        use_filename: true,
        unique_filename: true,
      },
      (err, result) => {
        if (err) {
          console.error("[storage] Cloudinary upload failed:", err.message);
          return resolve(null);
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(Buffer.from(buffer));
  });
}

/**
 * Delete a previously uploaded original — called when a document is replaced
 * (the old file is no longer what the row points to) or deleted outright.
 *
 * @param {string|null|undefined} publicId
 */
export async function deleteOriginalFile(publicId) {
  if (!publicId || !isConfigured()) return;
  ensureConfigured();
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });
  } catch (err) {
    console.error("[storage] Cloudinary delete failed:", err.message);
  }
}
