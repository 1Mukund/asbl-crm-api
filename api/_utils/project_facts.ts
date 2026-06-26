/**
 * Project facts — manually-curated rich Knowledge Base per project.
 *
 * MIGRATED FROM SUPABASE → MongoDB (Phase 5 of the Mongo migration).
 * Collection: "project_facts" inside the "Zoho_Database" Mongo db.
 *
 * Document schema (per project):
 *   {
 *     _id:            "LOFT"           // project name = PK
 *     project:        "LOFT",
 *     facts_text:     <curated offer details — manually written>,
 *     kb_text:        <auto-extracted from uploaded TXT/PDF>,
 *     kb_pdf_url:     <Supabase Storage public URL of last uploaded KB PDF>,
 *     offer_end_at:   ISO string or null (powers v5 OFFER_TIME_REMAINING),
 *     updated_at:     ISO string (touched on every facts_text write),
 *     kb_updated_at:  ISO string (touched on every kb_text write)
 *   }
 *
 * KB PDFs themselves stay in Supabase Storage per Mukund's directive
 * (PDFs ko mongo pe mat dalna). Only the extracted TEXT + the public
 * download URL live here.
 *
 * Backfill from Supabase:
 *   POST /api/chat-history?action=mongo-backfill&collection=project_facts&secret=<...>
 */

import { getCollection, COL } from "./mongo";

export const KNOWN_PROJECTS = ["LOFT", "SPECTRA", "BROADWAY", "LANDMARK", "LEGACY"] as const;
export type ProjectName = typeof KNOWN_PROJECTS[number];

export interface ProjectFacts {
  project: string;
  /** Curated OFFER details (manually written via dashboard "Edit ✎" form). */
  facts_text: string;
  /** General KB content (auto-extracted from uploaded TXT/PDF). */
  kb_text?: string;
  updated_at: string | null;
  kb_updated_at?: string | null;
  kb_pdf_url?: string | null;
  /** v5: rental/offer expiry timestamp — feeds OFFER_TIME_REMAINING. */
  offer_end_at?: string | null;
}

interface ProjectFactsDoc extends ProjectFacts {
  _id: string;   // project name
}

function fromDb(doc: any): ProjectFacts {
  if (!doc) return null as any;
  return {
    project: String(doc.project || doc._id || ""),
    facts_text: String(doc.facts_text || ""),
    kb_text: doc.kb_text ?? undefined,
    updated_at: doc.updated_at ?? null,
    kb_updated_at: doc.kb_updated_at ?? null,
    kb_pdf_url: doc.kb_pdf_url ?? null,
    offer_end_at: doc.offer_end_at ?? null,
  };
}

// ── Read ───────────────────────────────────────────────────────────────────
export async function getProjectFacts(project: string): Promise<ProjectFacts | null> {
  try {
    const col = await getCollection<ProjectFactsDoc>(COL.PROJECT_FACTS);
    const doc = await col.findOne({ _id: project as any });
    return doc ? fromDb(doc) : null;
  } catch (err: any) {
    console.error(`[ProjectFacts] read failed: ${err.message}`);
    return null;
  }
}

// ── Read all (for dashboard) ──────────────────────────────────────────────
export async function listAllProjectFacts(): Promise<ProjectFacts[]> {
  try {
    const col = await getCollection<ProjectFactsDoc>(COL.PROJECT_FACTS);
    const docs = await col.find({}).sort({ _id: 1 }).toArray();
    return docs.map(fromDb);
  } catch (err: any) {
    console.error(`[ProjectFacts] list failed: ${err.message}`);
    return [];
  }
}

// ── Write (upsert) — ONLY touches facts_text (offer details) ──────────────
// IMPORTANT: this does NOT touch kb_text. Use saveProjectKb() for KB uploads.
export async function saveProjectFacts(
  project: string,
  factsText: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!KNOWN_PROJECTS.includes(project as any)) {
    return { ok: false, error: `Unknown project: ${project}` };
  }
  try {
    const col = await getCollection<ProjectFactsDoc>(COL.PROJECT_FACTS);
    const now = new Date().toISOString();
    await col.updateOne(
      { _id: project as any },
      {
        $setOnInsert: { _id: project, project },
        $set: { facts_text: factsText, updated_at: now },
      },
      { upsert: true },
    );
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Write KB only — does NOT touch facts_text (offer details) ─────────────
// Used by the dashboard upload-kb handler. Updates kb_text + kb_pdf_url.
export async function saveProjectKb(
  project: string,
  kbText: string,
  kbPdfUrl: string | null,
): Promise<{ ok: boolean; error?: string }> {
  if (!KNOWN_PROJECTS.includes(project as any)) {
    return { ok: false, error: `Unknown project: ${project}` };
  }
  try {
    const col = await getCollection<ProjectFactsDoc>(COL.PROJECT_FACTS);
    const now = new Date().toISOString();
    const set: any = {
      kb_text: kbText,
      kb_updated_at: now,
    };
    if (kbPdfUrl) set.kb_pdf_url = kbPdfUrl;
    await col.updateOne(
      { _id: project as any },
      {
        $setOnInsert: {
          _id: project,
          project,
          facts_text: "",
          updated_at: now,
        },
        $set: set,
      },
      { upsert: true },
    );
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ASBL PORTFOLIO — authoritative cross-project status.
//
// The per-project PROJECT_CONTEXT only ever contains ONE project's data, so
// the bot has no reliable way to answer "which project is ready to move?"
// and was FABRICATING answers ("all our projects are under construction" —
// which is false, Spectra is ready-to-move). This block is injected into
// EVERY message so the bot always has the hard, ground-truth status of all
// projects: possession dates + ready-to-move flag.
//
// Stored in bot_settings.portfolio_overview (Mongo) so it is editable from
// the dashboard without a code deploy. Falls back to the seed below.
// ───────────────────────────────────────────────────────────────────────────
export const DEFAULT_PORTFOLIO_OVERVIEW = `ASBL PROJECT PORTFOLIO — AUTHORITATIVE STATUS (ground truth; use this for ANY ready-to-move / possession / "which project" question; NEVER contradict it; NEVER state a possession date that is not listed here):

- SPECTRA — READY TO MOVE IN. This is THE project to offer when a customer wants ready-to-move / ready possession / immediate move-in.
- BROADWAY — Under construction, possession December 2029. NOT ready-to-move.
- LOFT — Under construction. (Confirm the exact possession quarter before quoting a date.)
- LANDMARK — Under construction. (Confirm the exact possession quarter before quoting a date.)

HARD RULES:
- If the customer asks for "ready to move", "ready to move in", "ready possession", or "immediate possession", LEAD WITH SPECTRA by name and offer it. Do NOT say "all our projects are under construction" — that is FALSE.
- Only ever state a possession date that appears above. If a project's exact date is not listed, say you'll confirm and revert rather than guessing.
- Never claim Spectra is under construction. Spectra is ready-to-move.`;

let _portfolioCache: { val: string; at: number } | null = null;
const PORTFOLIO_TTL_MS = 60_000;

/** Authoritative cross-project status block, injected into every message.
 *  Reads bot_settings.portfolio_overview (editable from the dashboard);
 *  falls back to DEFAULT_PORTFOLIO_OVERVIEW. Cached 60s. */
export async function getPortfolioOverview(): Promise<string> {
  if (_portfolioCache && Date.now() - _portfolioCache.at < PORTFOLIO_TTL_MS) {
    return _portfolioCache.val;
  }
  let val = DEFAULT_PORTFOLIO_OVERVIEW;
  try {
    const { getBotSetting } = await import("./bot_settings");
    const row = await getBotSetting("portfolio_overview");
    if (row?.value && row.value.trim().length > 30) val = row.value.trim();
  } catch { /* fall back to default */ }
  _portfolioCache = { val, at: Date.now() };
  return val;
}
