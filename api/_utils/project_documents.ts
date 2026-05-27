/**
 * project_documents — Mongo wrapper for the PDF metadata table.
 *
 * MIGRATED FROM SUPABASE → MongoDB (Phase 6 of the Mongo migration).
 * Collection: "project_documents" inside the "Zoho_Database" Mongo db.
 *
 * IMPORTANT: the PDFs themselves stay in Supabase Storage per Mukund's
 * directive. Only metadata + the public download URL live here. When the
 * bot sends a PDF over Periskope it just forwards the Supabase Storage URL.
 *
 * Document schema (per uploaded PDF):
 *   {
 *     _id:              ObjectId | "sb_<id>" (backfilled rows preserve Supabase id),
 *     project:          "LOFT" | "SPECTRA" | ...
 *     doc_type:         "brochure" | "unit_plan" | "floor_plan" | "price_sheet"
 *                       | "master_plan" | "payment_structure" | "specifications"
 *                       | "amenities",
 *     filename:         original file name,
 *     url:              Supabase Storage public URL,
 *     size_label:       legacy free-text label (kept for backwards compat),
 *     unit_size_sft:    integer (v5 strict-lookup),
 *     facing:           "east" | "west" | ... (v5 strict-lookup),
 *     tower:            canonical tower id (v5 strict-lookup),
 *     text_extract:     up to 8000 chars of extracted PDF text (for grounding),
 *     text_extract_chars: full extracted length,
 *     text_extracted_at: ISO,
 *     fetched_at:       ISO (= createdAt on insert),
 *   }
 *
 * Indexes:
 *   { project:1, doc_type:1, unit_size_sft:1, facing:1, tower:1 }  strict lookup
 *   { project:1, doc_type:1, fetched_at:-1 }                       list/dashboard
 *   { text_extract:1 }                                              backfill scan
 */

import { getCollection, COL } from "./mongo";
import { ObjectId } from "mongodb";

export interface ProjectDocumentRow {
  _id?: string;
  project: string;
  doc_type: string;
  filename: string | null;
  url: string;
  size_label?: string | null;
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
  /** When true, this doc is sent for ANY request of its doc_type for the
   *  project — used for "single price sheet covers all units" projects so
   *  the bot doesn't need a per-config strict match. */
  applies_to_all?: boolean;
  text_extract?: string | null;
  text_extract_chars?: number | null;
  text_extracted_at?: string | null;
  fetched_at?: string | null;
}

/** Build a Mongo _id filter that matches BOTH a string _id (backfilled
 *  "sb_<id>") and an ObjectId _id (fresh uploads). The dashboard renders
 *  whatever String(_id) produces; for a 24-char hex we must reconstruct
 *  the ObjectId or the match silently fails. */
function idFilter(id: string): any {
  const variants: any[] = [{ _id: id }];
  if (/^[a-f0-9]{24}$/i.test(id)) {
    try { variants.push({ _id: new ObjectId(id) }); } catch {}
  }
  return variants.length === 1 ? variants[0] : { $or: variants };
}

let _indexesEnsured = false;
async function ensureIndexes(): Promise<void> {
  if (_indexesEnsured) return;
  try {
    const col = await getCollection(COL.PROJECT_DOCUMENTS);
    await Promise.all([
      col.createIndex(
        { project: 1, doc_type: 1, unit_size_sft: 1, facing: 1, tower: 1 },
        { name: "strict_lookup" },
      ),
      col.createIndex(
        { project: 1, doc_type: 1, fetched_at: -1 },
        { name: "list_by_project_type" },
      ),
      col.createIndex({ fetched_at: -1 }, { name: "fetched_at_desc" }),
    ]);
    _indexesEnsured = true;
  } catch (err: any) {
    console.error(`[project_documents] ensureIndexes failed: ${err.message}`);
  }
}

// ─── Read helpers ─────────────────────────────────────────────────────────

/** Strict-equality lookup. unit_size_sft / facing / tower are matched
 *  ONLY when caller supplied them (null/undefined = ignored). */
export async function findStrictDocs(input: {
  project: string;
  doc_type: string;
  unit_size_sft?: number | null;
  facing?: string | null;
  tower?: string | null;
  limit?: number;
}): Promise<ProjectDocumentRow[]> {
  await ensureIndexes();
  try {
    const col = await getCollection<ProjectDocumentRow>(COL.PROJECT_DOCUMENTS);
    const filter: any = { project: input.project, doc_type: input.doc_type };
    if (input.unit_size_sft != null) filter.unit_size_sft = input.unit_size_sft;
    if (input.facing) filter.facing = String(input.facing).toLowerCase();
    if (input.tower) filter.tower = String(input.tower);
    const cursor = col.find(filter).sort({ fetched_at: -1 }).limit(input.limit ?? 20);
    return await cursor.toArray();
  } catch (err: any) {
    console.error(`[project_documents] findStrictDocs failed: ${err.message}`);
    return [];
  }
}

/** Returns the project's "applies to all units" doc of a given type, if one
 *  exists (e.g. a single price sheet covering every config). Most-recent wins. */
export async function findAppliesToAllDoc(
  project: string,
  doc_type: string,
): Promise<ProjectDocumentRow | null> {
  await ensureIndexes();
  try {
    const col = await getCollection<ProjectDocumentRow>(COL.PROJECT_DOCUMENTS);
    const doc = await col
      .find({ project, doc_type, applies_to_all: true })
      .sort({ fetched_at: -1 })
      .limit(1)
      .next();
    return doc || null;
  } catch (err: any) {
    console.error(`[project_documents] findAppliesToAllDoc failed: ${err.message}`);
    return null;
  }
}

/** Most-recent N docs of (project, doc_type) — legacy fuzzy lookup path. */
export async function findDocsByType(
  project: string,
  doc_type: string,
  limit: number = 20,
): Promise<ProjectDocumentRow[]> {
  await ensureIndexes();
  try {
    const col = await getCollection<ProjectDocumentRow>(COL.PROJECT_DOCUMENTS);
    const cursor = col
      .find({ project, doc_type })
      .sort({ fetched_at: -1 })
      .limit(limit);
    return await cursor.toArray();
  } catch (err: any) {
    console.error(`[project_documents] findDocsByType failed: ${err.message}`);
    return [];
  }
}

/** Distinct size_label values for a (project, doc_type) — used for
 *  "which size?" clarification questions. */
export async function listSizeLabels(
  project: string,
  doc_type: string,
): Promise<string[]> {
  await ensureIndexes();
  try {
    const col = await getCollection<ProjectDocumentRow>(COL.PROJECT_DOCUMENTS);
    const rows = await col
      .find({ project, doc_type, size_label: { $ne: null } })
      .project({ size_label: 1 })
      .toArray();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows as any[]) {
      const lbl = r.size_label;
      if (lbl && !seen.has(lbl)) {
        seen.add(lbl);
        out.push(lbl);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** PDF-extract rows for a given project (text_extract not null) — used to
 *  build the "PDF DOCUMENT EXTRACTS" section in PROJECT_CONTEXT. */
export async function findExtractedDocsForProject(
  project: string,
  limit: number = 20,
): Promise<ProjectDocumentRow[]> {
  await ensureIndexes();
  try {
    const col = await getCollection<ProjectDocumentRow>(COL.PROJECT_DOCUMENTS);
    const cursor = col
      .find({ project, text_extract: { $ne: null } })
      .sort({ fetched_at: -1 })
      .limit(limit);
    return await cursor.toArray();
  } catch (err: any) {
    console.error(`[project_documents] findExtractedDocsForProject failed: ${err.message}`);
    return [];
  }
}

/** All docs (used by dashboard listing + backfill scans). */
export async function listAllDocs(opts: {
  project?: string;
  doc_type?: string;
  missing_text_extract?: boolean;
  limit?: number;
} = {}): Promise<ProjectDocumentRow[]> {
  await ensureIndexes();
  try {
    const col = await getCollection<ProjectDocumentRow>(COL.PROJECT_DOCUMENTS);
    const filter: any = {};
    if (opts.project) filter.project = opts.project;
    if (opts.doc_type) filter.doc_type = opts.doc_type;
    if (opts.missing_text_extract) {
      filter.$or = [{ text_extract: null }, { text_extract: { $exists: false } }];
    }
    const cursor = col.find(filter).sort({ fetched_at: -1 }).limit(opts.limit ?? 200);
    return await cursor.toArray();
  } catch (err: any) {
    console.error(`[project_documents] listAllDocs failed: ${err.message}`);
    return [];
  }
}

// ─── Write helpers ────────────────────────────────────────────────────────

export async function insertDoc(row: ProjectDocumentRow): Promise<string> {
  await ensureIndexes();
  const col = await getCollection<ProjectDocumentRow>(COL.PROJECT_DOCUMENTS);
  const now = new Date().toISOString();
  const toInsert: any = {
    ...row,
    fetched_at: row.fetched_at || now,
  };
  const res = await col.insertOne(toInsert);
  return String(res.insertedId);
}

/** Backfill upsert keyed on Supabase id ("sb_<id>") so re-runs are idempotent. */
export async function upsertDocBySupabaseId(
  supabaseId: number | string,
  row: ProjectDocumentRow,
): Promise<void> {
  await ensureIndexes();
  const _id = `sb_${supabaseId}`;
  const col = await getCollection(COL.PROJECT_DOCUMENTS);
  await col.updateOne(
    { _id: _id as any },
    { $set: { ...row, _id } as any },
    { upsert: true },
  );
}

export async function updateDocFields(
  _id: string,
  fields: Partial<ProjectDocumentRow>,
): Promise<void> {
  await ensureIndexes();
  const col = await getCollection(COL.PROJECT_DOCUMENTS);
  await col.updateOne(idFilter(_id), { $set: fields as any });
}

export async function deleteDoc(_id: string): Promise<void> {
  await ensureIndexes();
  const col = await getCollection(COL.PROJECT_DOCUMENTS);
  await col.deleteOne(idFilter(_id));
}
