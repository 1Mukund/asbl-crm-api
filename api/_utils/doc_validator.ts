/**
 * doc_validator — anti-hallucination guard for PDF delivery.
 *
 * The bot's JSON output has two related fields:
 *   reply         — natural-language WhatsApp message ("Sending 1695 east unit plan now")
 *   doc_to_send   — slug ("unit_plan") the doc dispatcher uses to pick a PDF
 *   doc_meta      — { unit_size_sft, facing, tower } the dispatcher matches strictly
 *
 * Issue 2 from the v5 spec: the bot's verbal mention of a size MUST match
 * the actual PDF that goes out. If reply says "1870" but doc_meta says
 * 1695, OR filename has 2520, we BLOCK the send and fall back to a safe
 * "let me confirm" message.
 *
 * Every send (passed, blocked or errored) is structured-logged to
 * doc_send_log so we can audit later via Supabase queries.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

export interface DocMeta {
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
}

export type ValidationOutcome =
  | { ok: true; sizes_in_reply: number[] }
  | { ok: false; reason: string; sizes_in_reply: number[] };

/** Extract sft / sqft / sq.ft sizes anywhere in the reply.
 *  Returns deduped numeric sizes in original order. */
export function extractSizesFromReply(reply: string): number[] {
  if (!reply) return [];
  // Match 3-5 digit numbers optionally followed by "sft", "sqft", "sq ft", "sq.ft"
  // We also include bare 4-digit numbers between 700–6000 if no immediate unit
  // marker is present (to catch "Sending the 1695 unit plan"). To avoid false
  // positives like phone numbers, we require word-boundary on both sides.
  const sizes: number[] = [];
  const seen = new Set<number>();

  const explicit = /\b(\d{3,5})\s*(?:sft|sqft|sq\.?\s*ft)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = explicit.exec(reply)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 300 && n <= 10000 && !seen.has(n)) {
      seen.add(n);
      sizes.push(n);
    }
  }

  // Implicit sizes — bare 4-digit numbers that the conversation context
  // clearly treats as a unit size ("the 1695 unit plan", "send 2035 plan").
  // We require a nearby keyword that signals "this is a unit size".
  const implicit = /\b(\d{4})\b(?=\s*(?:unit|plan|sft|configuration|config|east|west|north|south|bhk))/gi;
  while ((m = implicit.exec(reply)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 700 && n <= 6000 && !seen.has(n)) {
      seen.add(n);
      sizes.push(n);
    }
  }

  return sizes;
}

/** Pull a size hint out of a filename — e.g. "Loft-1695-East-FloorPlan.pdf"
 *  → 1695. Returns null if no plausible number is present. */
export function sizeFromFilename(filename: string | null | undefined): number | null {
  if (!filename) return null;
  // First explicit token like "1695sft" or "1870sqft"
  const explicit = filename.match(/(\d{3,5})\s*(?:sft|sqft)/i);
  if (explicit) {
    const n = parseInt(explicit[1], 10);
    if (n >= 300 && n <= 10000) return n;
  }
  // Bare 4-digit number in 700–6000 range
  const bare = filename.match(/\b(\d{4})\b/);
  if (bare) {
    const n = parseInt(bare[1], 10);
    if (n >= 700 && n <= 6000) return n;
  }
  return null;
}

/**
 * Validate that the doc the dispatcher resolved matches:
 *   - what the bot promised verbally (sizes in reply text)
 *   - the explicit doc_meta the bot asked for
 *
 * Pass when:
 *   - reply mentions no size → don't second-guess; trust doc_meta
 *   - reply mentions a size AND it matches doc_meta.unit_size_sft AND filename
 *   - filename has no size → trust doc_meta over filename
 *
 * Block when:
 *   - reply mentions a size that doesn't match doc_meta.unit_size_sft
 *   - reply mentions a size that doesn't match the filename's size
 *   - doc_meta says size X but filename has different size Y
 */
export function validateDocSend(
  reply: string,
  docMeta: DocMeta | null,
  filename: string | null,
): ValidationOutcome {
  const sizes = extractSizesFromReply(reply);

  // No size mentioned anywhere — accept whatever doc_meta resolved to.
  if (!sizes.length && (!docMeta || !docMeta.unit_size_sft)) {
    return { ok: true, sizes_in_reply: sizes };
  }

  const metaSize = docMeta?.unit_size_sft ?? null;
  const fileSize = sizeFromFilename(filename);

  // Reply mentioned size(s) but doc_meta has no size → bot promised verbally
  // without committing in meta → safer to block and re-ask.
  if (sizes.length && metaSize === null) {
    return {
      ok: false,
      reason: `reply mentions size ${sizes.join(",")} but doc_meta.unit_size_sft is null`,
      sizes_in_reply: sizes,
    };
  }

  // Reply size vs meta size
  if (sizes.length && metaSize !== null && !sizes.includes(metaSize)) {
    return {
      ok: false,
      reason: `reply says ${sizes.join(",")} but doc_meta says ${metaSize}`,
      sizes_in_reply: sizes,
    };
  }

  // Meta size vs filename size
  if (metaSize !== null && fileSize !== null && metaSize !== fileSize) {
    return {
      ok: false,
      reason: `doc_meta=${metaSize} but filename has ${fileSize}`,
      sizes_in_reply: sizes,
    };
  }

  // Reply size vs filename size (when no meta to triangulate)
  if (sizes.length && fileSize !== null && !sizes.includes(fileSize)) {
    return {
      ok: false,
      reason: `reply says ${sizes.join(",")} but filename has ${fileSize}`,
      sizes_in_reply: sizes,
    };
  }

  return { ok: true, sizes_in_reply: sizes };
}

// ─── Structured logging to doc_send_log ────────────────────────────────────

export type DocSendOutcome = "sent" | "blocked_mismatch" | "blocked_not_found" | "error";

export interface DocSendLogRow {
  phone: string;
  project: string | null;
  doc_type: string | null;
  doc_meta: DocMeta | null;
  matched_url: string | null;
  matched_file: string | null;
  reply_text: string | null;
  outcome: DocSendOutcome;
  block_reason: string | null;
  sizes_in_reply: number[];
}

export async function logDocSend(row: DocSendLogRow): Promise<void> {
  const body = {
    phone: row.phone,
    project: row.project,
    doc_type: row.doc_type,
    doc_meta: row.doc_meta,
    matched_url: row.matched_url,
    matched_file: row.matched_file,
    reply_text: row.reply_text ? row.reply_text.slice(0, 1000) : null,
    outcome: row.outcome,
    block_reason: row.block_reason,
    sizes_in_reply: row.sizes_in_reply,
  };

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/doc_send_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error(`[DocValidator] log insert failed ${r.status}: ${t.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.error(`[DocValidator] log insert threw: ${err.message}`);
  }
}

/** Safe-fallback wording when we BLOCK a doc send — never references the
 *  specific size we tried to send (that would compound the error). */
export const SAFE_FALLBACK_REPLY =
  "One sec — let me confirm the exact plan with the project team and send it across in a bit.";
