/**
 * Lead registry + leads storage — MIGRATED FROM Supabase Postgres functions
 * to MongoDB collections (Phase 7 of the Mongo migration, 2026-05-22).
 *
 * The file is still called `supabase.ts` so existing import sites don't
 * need to change — public API (getOrCreateMLID, getOrCreatePLID,
 * findLeadByPLID, upsertLead) is identical. Internally everything now
 * lives in the "Zoho_Database" Mongo db.
 *
 * Collections:
 *   mlid_registry — { _id: phone, mlid: "<numeric>", created_at }
 *   plid_registry — { _id: plid, plid, phone, mlid, project, created_at }
 *   leads         — { _id: plid, ...NormalizedLead fields, zoho_lead_id,
 *                     zoho_synced, zoho_synced_at, updated_at }
 *   _counters     — { _id: "mlid", seq: N } (atomic seed for new MLIDs)
 *
 * Atomic guarantees:
 *   - getOrCreateMLID: findOne fast path, else $inc on _counters.mlid then
 *     upsert with $setOnInsert. Race-safe — concurrent calls for the same
 *     phone may waste one counter value but the result is consistent.
 *   - getOrCreatePLID: same pattern, no counter needed (plid = mlid+project).
 *   - findLeadByPLID + upsertLead: direct collection ops keyed on plid (_id).
 *
 * The prior Supabase RPCs (get_or_create_mlid, get_or_create_plid) and the
 * `leads` table itself are no longer touched. They're left in place as a
 * read-only backup; Mongo is the single source of truth from this commit.
 */

import { NormalizedLead } from "./types";
import { getCollection, getNextSequence, COL } from "./mongo";

interface MlidRegistryDoc {
  _id: string;       // phone (digits only)
  phone: string;
  mlid: string;
  created_at: string | null;
}

interface PlidRegistryDoc {
  _id: string;       // plid
  plid: string;
  phone: string;
  mlid: string;
  project: string;
  created_at: string | null;
}

interface LeadDoc {
  _id: string;       // plid
  plid: string;
  mlid: string;
  phone: string;
  zoho_lead_id: string | null;
  zoho_synced: boolean;
  zoho_synced_at: string | null;
  updated_at: string;
  [key: string]: any;
}

function cleanPhone(p: string): string {
  return String(p || "").replace(/\D/g, "");
}

// ─── MLID: Atomic get-or-create (Mongo) ───────────────────────────────────

export async function getOrCreateMLID(phone: string): Promise<string> {
  const clean = cleanPhone(phone);
  if (!clean) throw new Error("getOrCreateMLID: empty phone");

  const col = await getCollection<MlidRegistryDoc>(COL.MLID_REGISTRY);

  // Fast path — existing phone has a known MLID
  const existing = await col.findOne({ _id: clean as any });
  if (existing?.mlid) return String(existing.mlid);

  // Slow path — allocate next MLID via atomic counter. The backfill from
  // the prior Supabase data seeded _counters.mlid.seq to max(existing)+10
  // so we don't collide with already-issued IDs.
  const next = await getNextSequence("mlid", 1000);
  const mlid = String(next);

  // Race-safe upsert. If a concurrent call inserted first, we get its
  // mlid back (because $setOnInsert won't overwrite). Our `next` from the
  // counter is wasted in that case — that's an acceptable tradeoff vs a
  // distributed lock.
  const result = await col.findOneAndUpdate(
    { _id: clean as any },
    {
      $setOnInsert: {
        _id: clean,
        phone: clean,
        mlid,
        created_at: new Date().toISOString(),
      } as any,
    },
    { upsert: true, returnDocument: "after" },
  );
  const persisted = (result as any)?.mlid || mlid;
  return String(persisted);
}

// ─── PLID: Atomic get-or-create (Mongo) ───────────────────────────────────

export async function getOrCreatePLID(
  phone: string,
  mlid: string,
  project: string,
): Promise<string> {
  const clean = cleanPhone(phone);
  if (!clean) throw new Error("getOrCreatePLID: empty phone");
  if (!mlid) throw new Error("getOrCreatePLID: empty mlid");
  const proj = String(project || "UNKNOWN").trim() || "UNKNOWN";
  const plid = `${mlid}-${proj}`;

  const col = await getCollection<PlidRegistryDoc>(COL.PLID_REGISTRY);
  await col.updateOne(
    { _id: plid as any },
    {
      $setOnInsert: {
        _id: plid,
        plid,
        phone: clean,
        mlid: String(mlid),
        project: proj,
        created_at: new Date().toISOString(),
      } as any,
    },
    { upsert: true },
  );
  return plid;
}

// ─── Lookup existing Zoho lead ID by PLID — race-fix path (a4e0d62) ────────
//
// Returns {zoho_lead_id, updated_at} or null. Used by ingest.ts to dedupe
// concurrent submissions before hitting Zoho's racy search API.

export async function findLeadByPLID(
  plid: string,
): Promise<{ zoho_lead_id: string | null; updated_at: string | null } | null> {
  if (!plid) return null;
  try {
    const col = await getCollection<LeadDoc>(COL.LEADS);
    const doc = await col.findOne({ _id: plid as any });
    if (!doc) return null;
    return {
      zoho_lead_id: doc.zoho_lead_id ?? null,
      updated_at: doc.updated_at ?? null,
    };
  } catch (err: any) {
    console.error(`[findLeadByPLID] failed: ${err.message}`);
    return null;
  }
}

// ─── Store lead in Mongo (source of truth + dedupe safety net) ───────────

export async function upsertLead(
  lead: NormalizedLead,
  mlid: string,
  plid: string,
  zohoLeadId: string | null,
  zohoSynced: boolean,
): Promise<void> {
  if (!plid) throw new Error("upsertLead: empty plid");
  const col = await getCollection<LeadDoc>(COL.LEADS);
  const now = new Date().toISOString();

  const doc: any = {
    _id: plid,
    mlid,
    plid,
    phone: cleanPhone(lead.mobile),
    first_name: lead.first_name,
    last_name: lead.last_name,
    email: lead.email ?? "",
    lead_source: lead.lead_source,
    source_lead_id: lead.source_lead_id ?? "",
    campaign_name: lead.campaign_name ?? "",
    ad_set_name: lead.ad_set_name ?? "",
    ad_name: lead.ad_name ?? "",
    utm_source: lead.utm_source ?? "",
    utm_medium: lead.utm_medium ?? "",
    utm_campaign: lead.utm_campaign ?? "",
    utm_content: lead.utm_content ?? "",
    utm_term: lead.utm_term ?? "",
    project: lead.project ?? "",
    lead_budget: lead.budget ?? "",
    size_preference: lead.size_preference ?? "",
    floor_preference: lead.floor_preference ?? "",
    possession_timeline: lead.possession_timeline ?? "",
    purchase_purpose: lead.purchase_purpose ?? "",
    lead_comments: lead.lead_comments ?? "",
    first_page_visited: lead.first_page_visited ?? "",
    last_page_visited: lead.last_page_visited ?? "",
    total_page_views: lead.total_page_views ?? 0,
    time_spent_minutes: lead.time_spent_minutes ?? 0,
    referrer_url: lead.referrer_url ?? "",
    zoho_lead_id: zohoLeadId,
    zoho_synced: zohoSynced,
    zoho_synced_at: zohoSynced ? now : null,
    lead_received_at: lead.lead_received_at,
    updated_at: now,
  };

  await col.updateOne(
    { _id: plid as any },
    { $set: doc },
    { upsert: true },
  );
}
