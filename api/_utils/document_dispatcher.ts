/**
 * Document dispatcher — looks up a project's brochure / price sheet /
 * payment structure / specifications / floor plan document and sends it
 * via Periskope when the customer's DOCUMENT_REQUEST intent matches.
 *
 * Lookup chain:
 *   1. project_documents collection in Mongo (Phase 6 migration)
 *   2. KB text (project_facts.facts_text) — auto-extracted via regex
 *
 * The PDFs themselves remain in Supabase Storage — only metadata + the
 * public download URL live in Mongo. Periskope just forwards the URL.
 */
import { getProjectFacts } from "./project_facts";
import { findDocInKB } from "./kb_doc_extractor";
import {
  findStrictDocs,
  findDocsByType,
  findAppliesToAllDoc,
  listSizeLabels,
  listAllDocs,
} from "./project_documents";

const PERISKOPE_API_KEY = process.env.PERISKOPE_API_KEY || "";

// Intent → doc_type mapping (legacy webhook intents — Gemini classifier
// uses DOCUMENT_REQUEST and we map directly via doc_type passed in).
const LEGACY_INTENT_TO_DOC: Record<string, string> = {
  brochure: "brochure",
  price: "price_sheet",
};

export interface ProjectDoc {
  url: string;
  doc_type: string;
  filename: string | null;
  size_label?: string | null;
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
  /** "table" | "kb" | "strict" — which source resolved this URL (for logs) */
  source?: string;
}

/** Result of a strict-equality lookup. Discriminated union so callers don't
 *  have to special-case null-vs-found inside a try/catch. */
export type StrictDocResult =
  | { ok: true; doc: ProjectDoc }
  | { ok: false; reason: "NOT_FOUND" | "AMBIGUOUS" | "ERROR"; details?: string; candidates?: ProjectDoc[] };

/** Normalise a size label for fuzzy matching: lowercase, strip non-alphanumeric. */
function normSize(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Doc types where the same doc_type can have MULTIPLE rows in
// project_documents, each disambiguated by size_label.
//   - floor_plan  → per-tower (Tower A, Tower B, ...)
//   - unit_plan   → per-unit-size (1695 East, 1870 West, ...)
//   - price_sheet → per-config / per-tower price sheets
const MULTI_SLOT_DOC_TYPES = new Set(["unit_plan", "floor_plan", "price_sheet"]);

export function isMultiSlotDocType(docType: string): boolean {
  return MULTI_SLOT_DOC_TYPES.has(docType);
}

/** List the available size_labels for a multi-slot doc type (for asking
 *  the customer "which tower / which size?" when the request is ambiguous). */
export async function listAvailableLabels(
  project: string,
  docType: string,
): Promise<string[]> {
  if (!MULTI_SLOT_DOC_TYPES.has(docType)) return [];
  try {
    return await listSizeLabels(project, docType);
  } catch {
    return [];
  }
}

// ── Strict-equality lookup using the bot's doc_meta ────────────────────────
// v5 behaviour: the LLM emits an explicit { unit_size_sft, facing, tower }
// alongside the doc slug. We match those fields EXACTLY against
// project_documents — NO fuzzy match, NO nearest-neighbour fallback. If no
// row matches, we surface NOT_FOUND and the caller falls back to a safe
// "let me confirm" message. If multiple match, AMBIGUOUS so the caller can
// ask the customer to disambiguate.
//
// Why so strict: the prior fuzzy match was sending the wrong-sized PDF (e.g.
// asked for 1870, sent 1695) because size_label was free-text. The v5 schema
// stores int + canonical enums so equality is safe.
export interface StrictDocLookupInput {
  project: string;
  docType: string;
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
}

export async function getDocumentStrict(
  input: StrictDocLookupInput,
): Promise<StrictDocResult> {
  const { project, docType } = input;
  if (!project || !docType) {
    return { ok: false, reason: "ERROR", details: "missing project or docType" };
  }

  try {
    // "Applies to all" short-circuit: if the project has a single doc of
    // this type flagged applies_to_all (e.g. one price sheet covering every
    // config), send THAT regardless of the meta the bot supplied. Lets
    // single-price-sheet projects work without per-config strict matching.
    const allDoc = await findAppliesToAllDoc(project, docType);
    if (allDoc) {
      return { ok: true, doc: { ...allDoc, source: "applies_to_all" } };
    }

    const rows = await findStrictDocs({
      project,
      doc_type: docType,
      unit_size_sft: input.unit_size_sft,
      facing: input.facing,
      tower: input.tower,
      limit: 20,
    });
    if (!rows.length) {
      return { ok: false, reason: "NOT_FOUND" };
    }
    if (rows.length === 1) {
      return { ok: true, doc: { ...rows[0], source: "strict" } };
    }
    return {
      ok: false,
      reason: "AMBIGUOUS",
      details: `${rows.length} rows matched (project,doc_type,unit_size_sft,facing,tower)`,
      candidates: rows.map((r) => ({ ...r, source: "strict" })),
    };
  } catch (err: any) {
    return { ok: false, reason: "ERROR", details: err.message };
  }
}

/** List the available labels for the customer when strict lookup says
 *  NOT_FOUND. Returns "1695 East-Tower A, 1870 West-Tower B, ..." style
 *  strings the caller can include in a clarification message. */
export async function listAvailableMetaLabels(
  project: string,
  docType: string,
): Promise<string[]> {
  try {
    const rows = await findDocsByType(project, docType, 200);
    const seen = new Set<string>();
    const out: string[] = [];
    // Sort by unit_size_sft ASC to mirror the prior Postgres order
    rows.sort((a, b) => (a.unit_size_sft ?? 0) - (b.unit_size_sft ?? 0));
    for (const row of rows) {
      const parts: string[] = [];
      if (row.unit_size_sft) parts.push(`${row.unit_size_sft} sft`);
      if (row.facing) parts.push(String(row.facing));
      if (row.tower) parts.push(`Tower ${row.tower}`);
      const label = parts.length ? parts.join(" ") : (row.size_label || "");
      if (label && !seen.has(label.toLowerCase())) {
        seen.add(label.toLowerCase());
        out.push(label);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Look up the matching document — table first, then KB extraction ──────
// Optional sizeHint helps unit_plan lookups (e.g. "1695 east", "2bhk", "1295").
//
// NOTE: this is the LEGACY fuzzy-match path. v5 callers should prefer
// getDocumentStrict() with the LLM's doc_meta. This function is preserved
// for (a) the dashboard's listAvailableLabels helper, (b) single-slot doc
// types where there's only one row per (project, doc_type) so fuzz is moot,
// and (c) fallback when an old upload doesn't have the new strict columns
// populated yet.
export async function getDocumentFor(
  project: string,
  intentOrDocType: string,
  sizeHint?: string | null
): Promise<ProjectDoc | null> {
  // Accept either a legacy intent ("brochure") or a doc_type slug ("brochure" / "price_sheet" / etc.)
  const docType = LEGACY_INTENT_TO_DOC[intentOrDocType] || intentOrDocType;
  if (!docType) return null;

  // 1. Try the curated project_documents collection first
  try {
    const rows = (await findDocsByType(project, docType, 20)) as ProjectDoc[];

    if (rows?.length) {
      // For multi-slot doc types (unit_plan / floor_plan / price_sheet),
      // try to match size_label fuzzily using the customer's message as
      // a hint. Single-slot types just return the most recent row.
      const isMulti = isMultiSlotDocType(docType);
      if (isMulti) {
        const hint = normSize(sizeHint);
        if (hint) {
          const matched = rows.find((row) => {
            const lbl = normSize(row.size_label);
            return lbl && (lbl.includes(hint) || hint.includes(lbl));
          });
          if (matched) return { ...matched, source: "table" };
        }
        // No hint OR hint didn't match any row → return NULL. The old
        // behaviour fell back to rows[0] (the most-recent upload), which
        // shipped the WRONG file when the customer's actual size wasn't
        // available — sales reported as "kabhi mango kuch aur, jata kuch
        // aur" (2026-06-18). Caller is expected to handle null by asking
        // a clarifying question instead of guessing.
        return null;
      }
      return { ...rows[0], source: "table" };
    }
  } catch (err: any) {
    console.error(`[DocDispatcher] table lookup failed: ${err.message}`);
  }

  // 2. Fallback: extract from the KB text
  try {
    const facts = await getProjectFacts(project);
    if (facts?.facts_text) {
      const kbDoc = findDocInKB(facts.facts_text, docType);
      if (kbDoc) {
        return {
          url: kbDoc.url,
          doc_type: kbDoc.docType,
          filename: kbDoc.filename,
          source: "kb",
        };
      }
    }
  } catch (err: any) {
    console.error(`[DocDispatcher] KB extraction failed: ${err.message}`);
  }

  return null;
}

// Sender pool. PROVEN-PARITY with the calling agent (2026-06-26): the
// calling agent reads its connected Periskope numbers from an env var, so
// when the connected set changes there's no code edit. The WhatsApp bot
// used to hardcode 10 numbers — if those drifted from the actually-connected
// Periskope phones, EVERY x-phone became invalid and docs silently failed
// (the "kuch nahi jaata" symptom). Now: read PERISKOPE_SENDERS (comma or
// space separated) first; fall back to the hardcoded list only if unset.
// Set PERISKOPE_SENDERS in Vercel to the SAME value the calling agent uses
// on Render to guarantee the senders are live.
const HARDCODED_DOC_SENDERS = [
  "917793952828", "919247598804", "919247597422", "919247597421",
  "919247597423", "919247597420", "919247597418", "919247597426",
  "919247597419", "919247597417",
];
const DOC_SENDER_POOL = (() => {
  const raw = process.env.PERISKOPE_SENDERS || "";
  const parsed = raw.split(/[\s,]+/).map((s) => s.replace(/\D/g, "")).filter((s) => s.length >= 10);
  return parsed.length ? parsed : HARDCODED_DOC_SENDERS;
})();

function isDeadSenderErr(status: number, body: string): boolean {
  const b = (body || "").toLowerCase();
  if (b.includes("phone server") && b.includes("switched off")) return true;
  if (b.includes("/phone/restart")) return true;
  if (b.includes("unauthorized_error")) return true;
  if (status === 401) return true;
  return false;
}

// ── Send document via Periskope ────────────────────────────────────────────
// Per Periskope docs: POST /v1/message/send with nested `media` object and
// chat_id in `<phone>@c.us` form. Two endpoints are tried per sender
// (singular + legacy plural alias). On 401 / "phone switched off" from
// Periskope (caller's sticky sender is offline), we fall through to other
// pool members exactly the way text-send does — without this, docs would
// silently fail whenever the conversation's primary sender was down.
// Bug observed 2026-06-19 in QA: PDFs weren't reaching customers even
// though text replies were getting through.
export async function sendDocViaPeriskope(
  phone: string,
  sender: string,
  docUrl: string,
  filename: string | null,
  caption: string,
  mimeType: string = "application/pdf"
): Promise<void> {
  const cleanPhone = String(phone).replace(/\D/g, "");
  const chatId = cleanPhone.includes("@") ? cleanPhone : `${cleanPhone}@c.us`;
  const safeFilename = filename || "document.pdf";

  const body = {
    chat_id: chatId,
    message: caption,
    media: { type: "document", filename: safeFilename, mimetype: mimeType, url: docUrl },
  };

  // Build sender order: caller's sticky first, then remaining pool members
  // (skipping recently-dead ones via ops_collections.getDeadSenders).
  let deadSet = new Set<string>();
  let markDead: ((s: string) => Promise<void>) | null = null;
  let recordOk: ((s: string) => Promise<void>) | null = null;
  try {
    const ops = await import("./ops_collections");
    deadSet = await ops.getDeadSenders().catch(() => new Set<string>());
    markDead = ops.markSenderDead;
    recordOk = ops.recordSenderSuccess;
  } catch {}

  const ordered: string[] = [];
  if (sender && !deadSet.has(sender)) ordered.push(sender);
  for (const s of DOC_SENDER_POOL) {
    if (s === sender) continue;
    if (deadSet.has(s)) continue;
    ordered.push(s);
  }
  if (!ordered.length) ordered.push(...DOC_SENDER_POOL);

  const endpoints = [
    "https://api.periskope.app/v1/message/send",   // documented
    "https://api.periskope.app/v1/messages/send",  // legacy / plural alias
  ];

  let lastErr = "";
  let triedSenders = 0;
  for (const trySender of ordered) {
    triedSenders++;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PERISKOPE_API_KEY}`,
      "x-phone": trySender,
    };
    let senderIsDead = false;
    for (const url of endpoints) {
      try {
        const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (r.ok) {
          if (recordOk) await recordOk(trySender).catch(() => {});
          if (triedSenders > 1) {
            console.log(`[DocDispatcher] sent doc via ${url} on sender ${trySender} (after ${triedSenders - 1} dead-sender fallback${triedSenders > 2 ? "s" : ""})`);
          } else {
            console.log(`[DocDispatcher] sent doc via ${url} → ${docUrl}`);
          }
          return;
        }
        const t = await r.text();
        lastErr = `${r.status} from ${url}: ${t.slice(0, 300)}`;
        if (isDeadSenderErr(r.status, t)) {
          console.warn(`[DocDispatcher] Sender ${trySender} dead (${r.status}). Marking + falling through to next sender.`);
          if (markDead) await markDead(trySender).catch(() => {});
          senderIsDead = true;
          break; // exit the inner endpoint loop, try next sender
        }
        if (r.status === 404) {
          console.warn(`[DocDispatcher] ${url} returned 404, trying alternate endpoint`);
          continue; // try the alternate endpoint with the same sender
        }
        // Non-sender, non-404 error (e.g. 400 bad payload, 5xx) — fatal
        throw new Error(`Periskope doc send error ${lastErr}`);
      } catch (err: any) {
        // For network exceptions, retry the same sender once on the alt
        // endpoint. If we're already on the last endpoint, propagate.
        if (url === endpoints[endpoints.length - 1] && !senderIsDead) {
          lastErr = err?.message || String(err);
          // Drop through to next sender (we've burned both endpoints
          // for the current sender).
          break;
        }
        lastErr = err?.message || String(err);
      }
    }
    if (!senderIsDead) {
      // Non-dead failure — we exited the endpoint loop without success
      // and without flagging the sender. No point trying other senders
      // for a payload-level error.
      throw new Error(`Periskope doc send failed: ${lastErr}`);
    }
  }
  throw new Error(`Periskope doc send EXHAUSTED — tried ${triedSenders} senders. Last: ${lastErr}`);
}
