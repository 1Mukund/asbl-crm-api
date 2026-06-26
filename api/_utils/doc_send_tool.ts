/**
 * Document Send Tool — the SINGLE entry point for every doc send in the
 * system. Periskope-webhook, cron, admin actions, and any future Gemini
 * function-calling integration all route through here.
 *
 * Why this exists: doc-send used to be inlined in periskope-webhook with
 * three near-duplicate code paths (strict lookup, legacy fallback,
 * SEND-ALL). Each path drifted slightly, so a bug fixed in one didn't
 * apply to the others (e.g. dead-sender pool fallback was added to
 * sendDocViaPeriskope only after user reported docs silently failing).
 *
 * The tool's contract:
 *   - Looks up matching rows in project_documents by (project, doc_type)
 *     and the disambiguation fields you pass in.
 *   - Decides one of: SEND (1+ rows match cleanly), AMBIGUOUS (multiple
 *     rows but no disambiguation hint), NOT_FOUND (zero rows).
 *   - On SEND, dispatches via sendDocViaPeriskope (which has 10-sender
 *     pool fallback on dead senders, two-endpoint retry on 404s).
 *   - Writes a structured doc_send_log entry per attempt for debugging.
 *   - Returns a structured result the caller renders into the WhatsApp
 *     reply text.
 *
 * Public surface (callable from any handler):
 *   sendDocumentTool({ request, phone, sender }) → SendDocResult
 *
 * Admin test endpoint: /api/chat-history?action=send-doc-test
 *   POST body: { phone, project, doc_type, size_label?, tower?, facing?,
 *                unit_size_sft?, send_all? }
 *   Fires the tool directly without going through Gemini — quick way to
 *   verify doc plumbing when the customer-facing flow is broken.
 */

import { findDocsByType, ProjectDocumentRow } from "./project_documents";
import { sendDocViaPeriskope } from "./document_dispatcher";
import { logDocSend } from "./doc_validator";

const MULTI_SLOT_TYPES = new Set(["unit_plan", "floor_plan", "price_sheet"]);
/** Hard cap on bulk sends — 8 PDFs at once is plenty for "all towers"
 *  and prevents accidental abuse. */
const BULK_SEND_CAP = 8;

export interface SendDocRequest {
  /** Project name as stored in project_documents.project (case-insensitive). */
  project: string;
  /** One of the 8 enum types: brochure / price_sheet / specifications /
   *  master_plan / floor_plan / unit_plan / payment_structure / amenities. */
  doc_type: string;
  /** Optional disambiguation. Any combination is accepted; the lookup
   *  picks rows matching the most specific field provided. */
  size_label?: string | null;
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
  /** When true, send EVERY available row (capped at BULK_SEND_CAP). Use
   *  when customer says "all towers", "every size", "saare", etc. */
  send_all_variants?: boolean;
}

export interface SendDocVariant {
  size_label: string;
  tower: string;
  facing: string;
  unit_size_sft: number | null;
  filename: string;
  url: string;
}

export interface SendDocResult {
  /** SEND = at least one doc delivered. AMBIGUOUS = multiple matches, caller
   *  must ask which one. NOT_FOUND = zero matches in project_documents.
   *  ERROR = Periskope or DB blew up. */
  outcome: "SEND" | "AMBIGUOUS" | "NOT_FOUND" | "ERROR";
  /** Number of docs actually delivered to Periskope without error. */
  sent_count: number;
  /** Per-variant details for variants we attempted (whether or not the
   *  attempt succeeded). The caller renders these into a reply caption. */
  variants_sent: SendDocVariant[];
  /** Variants the caller could offer the customer if outcome=AMBIGUOUS. */
  options?: string[];
  /** Periskope or lookup error message, present when outcome=ERROR or when
   *  sent_count < variants_sent.length (partial failure). */
  error?: string;
  /** Latency breakdown for ops dashboards. */
  ms: { lookup: number; send: number };
}

function rowToVariant(row: ProjectDocumentRow): SendDocVariant {
  return {
    size_label: String(row.size_label || ""),
    tower: String(row.tower || ""),
    facing: String(row.facing || ""),
    unit_size_sft: (row as any).unit_size_sft ?? null,
    filename: String(row.filename || "document.pdf"),
    url: row.url,
  };
}

function variantLabel(v: SendDocVariant): string {
  const parts: string[] = [];
  if (v.unit_size_sft) parts.push(`${v.unit_size_sft} sft`);
  if (v.facing) parts.push(v.facing);
  if (v.tower) parts.push(`Tower ${v.tower}`);
  if (parts.length) return parts.join(" ");
  return v.size_label || v.filename || "variant";
}

/** Build a caption for one PDF — short and human, no em-dash. */
function buildCaption(project: string, doc_type: string, variant: SendDocVariant): string {
  const label = variantLabel(variant);
  if (label && label !== doc_type) return `${project} ${doc_type} (${label})`;
  return `${project} ${doc_type}`;
}

/** Score how well a row matches the disambiguation fields. Higher is better.
 *  Used to pick the best row when the caller gave a hint but multiple rows
 *  could match (e.g. customer said "1980" but we have 1980-East and 1980-
 *  West rows). Returns 0 for no match, positive for partial, more for
 *  exact-attribute matches. */
function scoreRow(row: ProjectDocumentRow, hint: SendDocRequest): number {
  let score = 0;
  if (hint.unit_size_sft && (row as any).unit_size_sft === hint.unit_size_sft) score += 4;
  if (hint.facing && String(row.facing || "").toLowerCase() === hint.facing.toLowerCase()) score += 3;

  // Tower matching: exact on the dedicated `tower` field OR fuzzy by
  // looking for "Tower X" / "Tower-X" inside the size_label / filename.
  // This catches uploads where the tower was encoded into the label
  // (e.g. size_label = "Tower A-UrbanCorridor") instead of the tower
  // column. Bug observed 2026-06-19: customer typed "Tower A", strict
  // lookup with hint.tower = "A" matched nothing because Broadway rows
  // had tower field empty and the letter was buried in size_label.
  if (hint.tower) {
    const hintTower = String(hint.tower).toLowerCase().trim();
    if (hintTower) {
      if (String(row.tower || "").toLowerCase() === hintTower) score += 4;
      const lbl = String(row.size_label || "").toLowerCase();
      const fname = String(row.filename || "").toLowerCase();
      const patterns = [
        `tower ${hintTower}`, `tower-${hintTower}`, `tower_${hintTower}`,
        `t-${hintTower}`, `t${hintTower}`,
      ];
      if (patterns.some((p) => lbl.includes(p) || fname.includes(p))) score += 3;
    }
  }

  // size_label matching: exact + fuzzy contains
  if (hint.size_label) {
    const a = String(hint.size_label).toLowerCase();
    if (String(row.size_label || "").toLowerCase() === a) score += 5;
    if (row.size_label) {
      const b = String(row.size_label).toLowerCase();
      if (a.includes(b) || b.includes(a)) score += 2;
    }
  }
  return score;
}

/** THE TOOL. Caller hands in a request + the phone + the sender that the
 *  conversation is sticky-mapped to; we do everything else. */
export async function sendDocumentTool(opts: {
  request: SendDocRequest;
  phone: string;
  sender: string;
}): Promise<SendDocResult> {
  const t0 = Date.now();
  const cleanProject = String(opts.request.project || "").trim();
  let docType = String(opts.request.doc_type || "").trim().toLowerCase();

  // SPECTRA has no separate payment-structure PDF. Per business rule, a
  // request for it is served with the Spectra PRICE SHEET; the reply (from
  // Gemini, guided by the portfolio DOCUMENT RULE) tells the customer the
  // sales executive will walk them through payment structure at the site.
  // This is a hard safety net so we never return NOT_FOUND for that case.
  if (/spectra/i.test(cleanProject) && docType === "payment_structure") {
    docType = "price_sheet";
  }

  const isMulti = MULTI_SLOT_TYPES.has(docType);

  let rows: ProjectDocumentRow[] = [];
  try {
    rows = await findDocsByType(cleanProject, docType, 50);
  } catch (err: any) {
    return {
      outcome: "ERROR",
      sent_count: 0,
      variants_sent: [],
      error: `lookup failed: ${err.message}`,
      ms: { lookup: Date.now() - t0, send: 0 },
    };
  }

  const lookupMs = Date.now() - t0;

  // NOT_FOUND — caller renders a "we don't have that doc" reply.
  if (!rows || rows.length === 0) {
    return {
      outcome: "NOT_FOUND",
      sent_count: 0,
      variants_sent: [],
      error: `no rows for project=${cleanProject} doc_type=${docType}`,
      ms: { lookup: lookupMs, send: 0 },
    };
  }

  // BULK / SEND-ALL — caller explicitly asked for every variant.
  let chosen: ProjectDocumentRow[] = [];
  if (opts.request.send_all_variants) {
    chosen = rows.slice(0, BULK_SEND_CAP);
  } else if (!isMulti) {
    // Single-slot doc type — always returns the most recently uploaded row.
    chosen = [rows[0]];
  } else if (rows.length === 1) {
    // CRITICAL FIX (R1, 2026-06-26): a multi-slot doc_type (price_sheet /
    // floor_plan / unit_plan) that has exactly ONE uploaded row is NOT
    // ambiguous — there is only one thing we could possibly send. The old
    // code fell into the scoring branch below, scored the single row 0
    // (no hint), and returned AMBIGUOUS → bot asked "which one: Spectra"
    // with a single option. Just send it.
    chosen = [rows[0]];
  } else if (rows.some((r) => (r as any).applies_to_all === true)) {
    // A row flagged applies_to_all covers every config for this doc_type
    // (e.g. one price sheet for the whole project). Send that one.
    const allRow = rows.find((r) => (r as any).applies_to_all === true);
    chosen = allRow ? [allRow] : [rows[0]];
  } else {
    // Multi-slot, multiple rows. Score by disambiguation hint(s); a clear
    // unique winner (highest score > 0) → send. No hint or a tie → AMBIGUOUS,
    // surface the options for the caller to ask which one.
    const scored = rows
      .map((r) => ({ r, s: scoreRow(r, opts.request) }))
      .sort((a, b) => b.s - a.s);
    const top = scored[0].s;
    const winners = scored.filter((x) => x.s === top);
    if (top > 0 && winners.length === 1) {
      chosen = [winners[0].r];
    } else {
      // No hint, or tie. Surface the options for the caller to ask.
      const options = rows.map((r) => {
        const v = rowToVariant(r);
        return variantLabel(v);
      });
      return {
        outcome: "AMBIGUOUS",
        sent_count: 0,
        variants_sent: rows.map(rowToVariant),
        options,
        ms: { lookup: lookupMs, send: 0 },
      };
    }
  }

  // SEND — fire each chosen row in sequence.
  const tSend0 = Date.now();
  const attempted: SendDocVariant[] = [];
  let sent = 0;
  let lastErr = "";
  for (const row of chosen) {
    const v = rowToVariant(row);
    attempted.push(v);
    const caption = buildCaption(cleanProject, docType, v);
    try {
      await sendDocViaPeriskope(opts.phone, opts.sender, row.url, row.filename, caption);
      sent++;
      await logDocSend({
        phone: opts.phone,
        project: cleanProject,
        doc_type: docType,
        doc_meta: {
          unit_size_sft: v.unit_size_sft ?? null,
          facing: v.facing || null,
          tower: v.tower || null,
        },
        matched_url: row.url,
        matched_file: row.filename,
        reply_text: caption,
        outcome: "sent",
        block_reason: null,
        sizes_in_reply: v.unit_size_sft ? [v.unit_size_sft] : [],
      }).catch(() => {});
    } catch (err: any) {
      lastErr = err?.message || String(err);
      await logDocSend({
        phone: opts.phone,
        project: cleanProject,
        doc_type: docType,
        doc_meta: {
          unit_size_sft: v.unit_size_sft ?? null,
          facing: v.facing || null,
          tower: v.tower || null,
        },
        matched_url: row.url,
        matched_file: row.filename,
        reply_text: caption,
        outcome: "blocked_not_found",
        block_reason: lastErr,
        sizes_in_reply: [],
      }).catch(() => {});
    }
  }

  return {
    outcome: sent > 0 ? "SEND" : "ERROR",
    sent_count: sent,
    variants_sent: attempted,
    error: sent === attempted.length ? undefined : lastErr,
    ms: { lookup: lookupMs, send: Date.now() - tSend0 },
  };
}
