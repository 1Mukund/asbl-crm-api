/**
 * Manual-reactivation phone list (2026-07).
 *
 * The ops team pushes a batch of ~3000 existing customers back through the
 * SAME Inncircles M1 webhook to re-engage them ("AI Bot Leads Calling"). The
 * webhook hardcodes Lead_Source = "Inncircles M1", but these are NOT fresh
 * Inncircles leads — their source must read "Manual Reactivation" in Zoho.
 *
 * We can't match on lead id (the sheet carries an internal master-lead id, the
 * webhook only sends a source lead id), so we match on PHONE. This module holds
 * the phone allowlist in Mongo (COL.REACTIVATION_LIST, _id = normalized phone)
 * and the ingest handler flips the source when an incoming phone is present.
 *
 * The sheet's `latest_project` is stored for reference/verification only — the
 * webhook already sends each phone with its correct latest project, so call
 * routing is unchanged (normal +30min / 15-per-tick batched rules apply).
 */
import { getCollection, COL } from "./mongo";
import { normalizePhone } from "./normalize";

export interface ReactivationEntry {
  phone: string;          // normalized (91XXXXXXXXXX)
  latest_project?: string;
  masterleadid?: string;
}

interface ReactivationDoc extends ReactivationEntry {
  _id: string;            // normalized phone
  added_at?: string;
}

/** Lookup: is this phone on the reactivation list? Returns the entry (with the
 *  reference latest_project) or null. Matches on the normalized phone so any
 *  input format (10-digit / +91 / 91-prefixed) resolves the same row. */
export async function getReactivationEntry(phone: string): Promise<ReactivationEntry | null> {
  try {
    const norm = normalizePhone(phone);
    if (!norm) return null;
    const col = await getCollection<ReactivationDoc>(COL.REACTIVATION_LIST);
    const doc = await col.findOne({ _id: norm as any });
    if (!doc) return null;
    return { phone: norm, latest_project: doc.latest_project, masterleadid: doc.masterleadid };
  } catch (err: any) {
    // Never block ingest on a reactivation-list read failure — just treat the
    // lead as a normal Inncircles lead.
    console.error(`[Reactivation] lookup failed for ${phone}: ${err.message}`);
    return null;
  }
}

/** Bulk-load the reactivation list. Normalizes each phone; rows whose phone
 *  can't be normalized are returned in `skipped` for review. Upserts by _id so
 *  re-uploads are idempotent. `wipe` clears the whole list first. */
export async function loadReactivationList(
  rows: Array<{ phone: any; latest_project?: any; masterleadid?: any }>,
  opts: { wipe?: boolean; added_at: string },
): Promise<{ inserted: number; skipped: Array<{ raw: any; reason: string }>; wiped: number }> {
  const col = await getCollection<ReactivationDoc>(COL.REACTIVATION_LIST);
  let wiped = 0;
  if (opts.wipe) {
    const r = await col.deleteMany({});
    wiped = r.deletedCount || 0;
  }
  const skipped: Array<{ raw: any; reason: string }> = [];
  const ops: any[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const norm = normalizePhone(row?.phone != null ? String(row.phone) : "");
    if (!norm || norm.length < 10) {
      skipped.push({ raw: row?.phone ?? null, reason: "unnormalizable phone" });
      continue;
    }
    if (seen.has(norm)) continue; // dedupe within the batch
    seen.add(norm);
    ops.push({
      updateOne: {
        filter: { _id: norm },
        update: {
          $set: {
            _id: norm,
            phone: norm,
            latest_project: row?.latest_project != null ? String(row.latest_project).trim().toUpperCase() : undefined,
            masterleadid: row?.masterleadid != null ? String(row.masterleadid) : undefined,
            added_at: opts.added_at,
          },
        },
        upsert: true,
      },
    });
  }
  let inserted = 0;
  if (ops.length) {
    const res = await col.bulkWrite(ops, { ordered: false });
    inserted = (res.upsertedCount || 0) + (res.modifiedCount || 0);
  }
  return { inserted, skipped, wiped };
}
