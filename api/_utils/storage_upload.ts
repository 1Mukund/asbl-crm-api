/**
 * Supabase Storage upload helpers + PDF text extraction.
 *
 * Used by the dashboard's upload-kb / upload-doc endpoints. Browser-side
 * the form converts the chosen file → base64 → JSON POST to our endpoint.
 * Server-side we decode → upload to bucket `project-files` → return public URL.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const BUCKET = "project-files";

export interface UploadResult {
  publicUrl: string;
  storagePath: string;
}

/**
 * Upload a base64-encoded file to Supabase Storage. Returns public URL.
 * Path format: <project>/<doc_type>/[<size_label>/]<timestamp>-<filename>
 */
export async function uploadToStorage(opts: {
  project: string;
  docType: string;
  filename: string;
  mimeType: string;
  base64Content: string;
  sizeLabel?: string | null;
}): Promise<UploadResult> {
  const projectSlug = opts.project.toLowerCase();
  const docTypeSlug = opts.docType.toLowerCase();
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = Date.now();

  const pathParts = [projectSlug, docTypeSlug];
  if (opts.sizeLabel) pathParts.push(safe(opts.sizeLabel));
  pathParts.push(`${ts}-${safe(opts.filename)}`);
  const storagePath = pathParts.join("/");

  // Decode base64 to binary
  const buffer = Buffer.from(opts.base64Content, "base64");

  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`,
    {
      method: "POST",
      headers: {
        "Content-Type": opts.mimeType || "application/octet-stream",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "x-upsert": "true",
      },
      body: buffer,
    }
  );

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Storage upload ${r.status}: ${errText.slice(0, 200)}`);
  }

  // Public URL (bucket is public)
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
  return { publicUrl, storagePath };
}

/**
 * Extract text from a PDF buffer using pdf-parse.
 * Returns the extracted plaintext (or empty string on parse failure).
 */
export async function extractTextFromPDF(pdfBuffer: Buffer): Promise<string> {
  try {
    // Lazy-load pdf-parse so module doesn't blow up on startup if missing.
    // pdf-parse ships no types — cast through any.
    // @ts-ignore — no @types/pdf-parse package
    const pdfParse: any = (await import("pdf-parse")).default;
    const data = await pdfParse(pdfBuffer);
    return (data?.text || "").trim();
  } catch (err: any) {
    console.error(`[storage_upload] PDF text extraction failed: ${err.message}`);
    return "";
  }
}

/** Decode UTF-8 text from base64 (for TXT KB uploads). */
export function decodeBase64Text(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf-8");
}

/** Decode arbitrary base64 to a Buffer. */
export function decodeBase64Buffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}
