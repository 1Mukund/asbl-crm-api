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
 * Extract text from a PDF buffer.
 *
 * Two-tier:
 *   1. pdf-parse — fast, free, works for text-layer PDFs (specs sheets, price
 *      sheets, payment plans).
 *   2. Gemini 2.0 Flash with vision — handles image-only / scanned PDFs
 *      (most real-estate brochures, master plans, floor plans, unit plans).
 *      Uses the same GEMINI_API_KEY we already have — costs ~₹0.50 per PDF.
 *
 * Returns extracted plaintext; empty string only if BOTH paths fail.
 */
export async function extractTextFromPDF(pdfBuffer: Buffer): Promise<string> {
  // ── Tier 1 — pdf-parse (text-layer PDFs) ─────────────────────────────
  try {
    // @ts-ignore — pdf-parse ships no types
    const pdfParse: any = (await import("pdf-parse")).default;
    const data = await pdfParse(pdfBuffer);
    const text = (data?.text || "").trim();
    if (text && text.length > 100) {
      return text; // good extract — text-layer PDF
    }
    // Otherwise fall through to vision OCR
    console.log(`[storage_upload] pdf-parse returned ${text.length} chars — falling back to Vision OCR`);
  } catch (err: any) {
    console.warn(`[storage_upload] pdf-parse threw: ${err.message} — trying Vision OCR`);
  }

  // ── Tier 2 — Gemini vision OCR (image-only PDFs) ─────────────────────
  // Throw the underlying error so the backfill caller can surface it
  // instead of swallowing into an empty string.
  return await extractWithGeminiVision(pdfBuffer);
}

/** Extract text from a PDF using Gemini 2.0 Flash vision.
 *  Cap inline data at 15 MB (Gemini inline limit is 20 MB; leaves headroom). */
async function extractWithGeminiVision(pdfBuffer: Buffer): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured");
  if (pdfBuffer.length > 15 * 1024 * 1024) {
    throw new Error(`PDF too large (${(pdfBuffer.length / 1024 / 1024).toFixed(1)} MB) — exceeds inline-vision cap`);
  }

  // Try multiple model names — Gemini API model availability varies per
  // API key tier. We attempt them in order from cheapest/fastest to most
  // capable until one returns 200.
  const candidates = (process.env.GEMINI_VISION_MODEL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!candidates.length) {
    candidates.push(
      "gemini-2.5-flash",
      "gemini-2.0-flash-001",
      "gemini-1.5-flash-002",
      "gemini-1.5-flash-latest",
      "gemini-1.5-flash",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
    );
  }

  let lastErr = "";
  for (const visionModel of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${visionModel}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: "application/pdf",
              data: pdfBuffer.toString("base64"),
            },
          },
          {
            text:
              "You are a document OCR + extraction tool. Extract ALL textual content " +
              "from this real-estate document — every label, dimension, square footage, " +
              "price, balcony measurement, room size, amenity name, specification, " +
              "RERA / approval number, and any other text visible on any page. " +
              "Preserve numbers exactly. Return as plain text — no markdown, no " +
              "commentary, no preface. Just the document's raw text content, " +
              "page by page.",
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 8000,
    },
  };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const errText = await r.text();
        lastErr = `${visionModel} → ${r.status}: ${errText.slice(0, 100)}`;
        if (r.status === 404) {
          // Model not accessible — try next candidate
          console.warn(`[Vision OCR] ${visionModel} not accessible (404), trying next...`);
          continue;
        }
        throw new Error(`Vision API ${r.status} on ${visionModel}: ${errText.slice(0, 200)}`);
      }
      const data = (await r.json()) as any;
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const text = parts.map((p: any) => p?.text || "").join("").trim();
      if (!text) {
        const finishReason = data?.candidates?.[0]?.finishReason || "unknown";
        lastErr = `${visionModel} → empty (finishReason: ${finishReason})`;
        continue;
      }
      console.log(`[Vision OCR] ${visionModel} succeeded — ${text.length} chars`);
      return text;
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        lastErr = `${visionModel} timed out`;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`All vision models failed. Last error: ${lastErr}`);
}

/** Decode UTF-8 text from base64 (for TXT KB uploads). */
export function decodeBase64Text(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf-8");
}

/** Decode arbitrary base64 to a Buffer. */
export function decodeBase64Buffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/**
 * Create a Supabase Storage signed-upload URL so the browser can PUT
 * a large file DIRECTLY to Supabase (bypassing Vercel's 4.5 MB body cap).
 * Returns the path under Supabase Storage's REST API.
 */
export async function createSignedUploadUrl(opts: {
  project: string;
  docType: string;
  filename: string;
  sizeLabel?: string | null;
}): Promise<{ uploadPath: string; token: string; storagePath: string; publicUrl: string }> {
  const projectSlug = opts.project.toLowerCase();
  const docTypeSlug = opts.docType.toLowerCase();
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
  const ts = Date.now();

  const pathParts = [projectSlug, docTypeSlug];
  if (opts.sizeLabel) pathParts.push(safe(opts.sizeLabel));
  pathParts.push(`${ts}-${safe(opts.filename)}`);
  const storagePath = pathParts.join("/");

  // Supabase Storage signed-upload-URL endpoint
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${storagePath}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`signed-url ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  // data.url is like "/object/upload/sign/<bucket>/<path>?token=..."
  const uploadPath = `${SUPABASE_URL}/storage/v1${data.url}`;
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
  return { uploadPath, token: data.token, storagePath, publicUrl };
}

/** Download a previously-uploaded object from Supabase Storage as a Buffer. */
export async function downloadFromStorage(storagePath: string): Promise<Buffer> {
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`,
    {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }
  );
  if (!r.ok) {
    throw new Error(`storage download ${r.status}: ${await r.text()}`);
  }
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}
