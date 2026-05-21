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
