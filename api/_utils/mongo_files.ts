/**
 * Mongo-hosted document storage (GridFS) — so the bot is 100% independent
 * of any external object store.
 *
 * Why: every doc PDF used to live in Supabase Storage, with only the URL in
 * Mongo project_documents. When that Supabase project got DELETED, every
 * URL went dead and no document could be delivered (Periskope fetches the
 * file from the URL). Storing the binary in Mongo (GridFS) and serving it
 * from our OWN endpoint removes the third-party dependency entirely — a
 * Supabase project can never disappear out from under us again.
 *
 * Flow:
 *   upload  -> storeFile(buffer) -> GridFS, returns fileId
 *              project_documents.url = "<SELF>/api/chat-history?action=doc-file&id=<fileId>"
 *   send    -> Periskope fetches that URL -> our doc-file endpoint streams
 *              the PDF straight out of GridFS with Content-Type application/pdf.
 *
 * GridFS chunks large files automatically, so brochures of any size work
 * (subject only to the Vercel request-body cap on the UPLOAD leg, which the
 * dashboard's base64 POST path handles for the common doc sizes).
 */
import { GridFSBucket, ObjectId } from "mongodb";
import { getDb } from "./mongo";

const BUCKET = "doc_files";

/** Store a file buffer in GridFS. Returns the string fileId to embed in the
 *  public serve URL. metadata is optional bookkeeping (project, doc_type). */
export async function storeFile(
  buffer: Buffer,
  filename: string,
  contentType: string,
  metadata?: Record<string, any>,
): Promise<string> {
  const db = await getDb();
  const bucket = new GridFSBucket(db, { bucketName: BUCKET });
  return await new Promise<string>((resolve, reject) => {
    const stream = bucket.openUploadStream(filename || "document.pdf", {
      // contentType isn't on the driver's options type but is read back from
      // the files doc; store it in metadata too so getFile can recover it.
      metadata: { ...(metadata || {}), contentType: contentType || "application/pdf" },
    });
    stream.on("error", reject);
    stream.on("finish", () => resolve(String(stream.id)));
    stream.end(buffer);
  });
}

/** Read a file back out of GridFS by id. Returns null if not found. */
export async function getFile(
  id: string,
): Promise<{ buffer: Buffer; contentType: string; filename: string } | null> {
  let _id: ObjectId;
  try { _id = new ObjectId(id); } catch { return null; }
  const db = await getDb();
  const bucket = new GridFSBucket(db, { bucketName: BUCKET });
  const files = await db.collection(`${BUCKET}.files`).find({ _id }).limit(1).toArray();
  if (!files.length) return null;
  const f = files[0] as any;
  const ctype = f.contentType || f.metadata?.contentType || "application/pdf";
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    const stream = bucket.openDownloadStream(_id);
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("error", reject);
    stream.on("end", () =>
      resolve({
        buffer: Buffer.concat(chunks),
        contentType: ctype,
        filename: f.filename || "document.pdf",
      }),
    );
  });
}

/** Delete a stored file (used when a doc is replaced/removed). Best-effort. */
export async function deleteFile(id: string): Promise<void> {
  try {
    const _id = new ObjectId(id);
    const db = await getDb();
    const bucket = new GridFSBucket(db, { bucketName: BUCKET });
    await bucket.delete(_id);
  } catch { /* ignore */ }
}

/** Build the public serve URL for a stored fileId. This is what gets saved
 *  as project_documents.url and handed to Periskope. */
export function fileServeUrl(fileId: string): string {
  const base = (process.env.SELF_PUBLIC_URL || "https://growth-relay.asbl.in").replace(/\/+$/, "");
  return `${base}/api/chat-history?action=doc-file&id=${fileId}`;
}
