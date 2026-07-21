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

// ─── Atomic "claim" for lead creation — closes the last race window ──────
//
// Background: Phase 7 made the leads collection key on _id=plid so two
// concurrent ingest requests with the same (phone, project) end up writing
// to the same Mongo _id. Mongo serialises them, so only ONE leads doc
// exists. But the upsertLead at the end of ingestLead is a $set OVERWRITE,
// and the *Zoho* createLead call is NOT atomic — so two requests that both
// see findLeadByPLID=null both call Zoho createLead, producing TWO Zoho
// IDs even though only one leads-doc exists.
//
// Fix (2026-05-26): claim a creation slot in Mongo BEFORE calling Zoho.
// findOneAndUpdate with returnDocument:'before' returns null IFF we just
// inserted the doc (we are FIRST). Anyone else who tries to insert the
// same plid gets back the pre-existing doc (we are DUPLICATE). The
// duplicate path then waits briefly for the first request's zoho_lead_id
// to land, and uses that ID for its updateLead instead of creating a new
// Zoho lead.
//
// Result: even if 10 requests for the same (phone, project) hit the
// webhook within 100ms, only ONE Zoho lead is created. The others all
// resolve to that one ID and route to updateLead.

export type ClaimResult =
  | { status: "first" }                             // we won the race → create in Zoho
  | { status: "duplicate"; zoho_lead_id: string }   // someone else already created
  | { status: "duplicate_pending" };                // someone else creating but ID not landed yet

export async function claimLeadCreation(
  plid: string,
  phone: string,
  mlid: string,
  waitMs: number = 6000,
): Promise<ClaimResult> {
  if (!plid) throw new Error("claimLeadCreation: empty plid");
  const col = await getCollection<LeadDoc>(COL.LEADS);
  const now = new Date().toISOString();

  // returnDocument:'before' → null IFF we just inserted (upsert created
  // the doc), non-null IFF doc existed (we lost the race).
  const before = await col.findOneAndUpdate(
    { _id: plid as any },
    {
      $setOnInsert: {
        _id: plid,
        plid,
        phone: cleanPhone(phone),
        mlid,
        zoho_lead_id: null,
        zoho_synced: false,
        zoho_synced_at: null,
        creation_in_progress: true,
        created_at: now,
        updated_at: now,
      } as any,
    },
    { upsert: true, returnDocument: "before" },
  );

  if (!before) {
    // We just inserted → we are FIRST
    return { status: "first" };
  }

  const existing = before as any;
  if (existing.zoho_lead_id) {
    // Someone else already finished — use their ID, skip Zoho create
    return { status: "duplicate", zoho_lead_id: String(existing.zoho_lead_id) };
  }

  // Doc exists but no zoho_lead_id yet — the first request is mid-flight.
  // Poll briefly so we get its ID once the create completes.
  const start = Date.now();
  const interval = 200;
  while (Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, interval));
    const check = await col.findOne({ _id: plid as any });
    if ((check as any)?.zoho_lead_id) {
      return { status: "duplicate", zoho_lead_id: String((check as any).zoho_lead_id) };
    }
  }
  // First request timed out — return pending so caller decides whether
  // to fall through to Zoho create (last-resort behaviour) or skip.
  return { status: "duplicate_pending" };
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
    // Manual-reactivation: mirror the latest-project flag into Mongo too (for
    // the in-house CRM). null for non-reactivation leads, true/false otherwise.
    reactivation_is_latest: lead.reactivation_is_latest ?? null,
    // Inncircles origin flags (mirror into Mongo for the in-house CRM).
    is_reactivated: lead.inncircles_flags?.is_reactivated ?? null,
    is_born_fresh: lead.inncircles_flags?.is_born_fresh ?? null,
    is_born_in_other_project: lead.inncircles_flags?.is_born_in_other_project ?? null,
    is_bulk_transfer: lead.inncircles_flags?.is_bulk_transfer ?? null,
    zoho_lead_id: zohoLeadId,
    zoho_synced: zohoSynced,
    zoho_synced_at: zohoSynced ? now : null,
    lead_received_at: lead.lead_received_at,
    // Original born date at source (caller-supplied); falls back to the
    // CRM-entry date so the in-house CRM always has a value.
    born_date: lead.born_date ?? lead.lead_received_at.slice(0, 10),
    updated_at: now,
  };

  await col.updateOne(
    { _id: plid as any },
    { $set: doc },
    { upsert: true },
  );
}

// ─── Mirror PRD state from Zoho into Mongo `leads` collection ─────────────
// Every PRD update site (cron increments, state-machine transitions,
// inhouse-call call_id stamp, posthook Call_Status update) calls this
// AFTER its Zoho updateLead — so Mongo holds the same lifecycle state
// Zoho holds, just with snake_case field names. Eventual consistency is
// fine; Zoho remains source-of-truth, Mongo is read-side optimisation +
// resilience against Zoho outages.
//
// Whitelist-driven — only fields in ZOHO_TO_MONGO_PRD_FIELD_MAP are
// mirrored. Any other key in the input map is silently skipped (so
// callers can pass their existing Zoho payload as-is without filtering).
const ZOHO_TO_MONGO_PRD_FIELD_MAP: Record<string, string> = {
  PRD_Stage:                "prd_stage",
  PRD_Status:               "prd_status",
  PRD_Last_Action:          "prd_last_action",
  PRD_Last_Action_Time:     "prd_last_action_time",
  Chatbot_Attempt_Count:    "chatbot_attempt_count",
  Chatbot_Follow_up_Count:  "chatbot_follow_up_count",
  SS_Call_Attempt_Count:    "ss_call_attempt_count",
  Call_Status:              "call_status",
  Call_Duration:            "call_duration",
  Total_Call_Duration_Secs: "total_call_duration_secs",
  Next_Call_At:             "next_call_at",   // call-timing gate — must mirror
                                              // in real-time (not just 15-min
                                              // sync) so Mongo-based reads see
                                              // the current schedule.
  Last_Inhouse_Call_ID:     "last_inhouse_call_id",
  Last_Arrowhead_Call_ID:   "last_arrowhead_call_id",
  Lead_Status:              "lead_status",
  Site_Visit_Date:          "site_visit_date",
  Last_Recording_URL:       "last_recording_url",
  Call_Attempt_Count:       "call_attempt_count",
  Last_Call_At:             "last_call_at",
};

export async function mirrorLeadStateToMongo(
  zohoLeadId: string,
  zohoFields: Record<string, any>,
): Promise<void> {
  if (!zohoLeadId || !zohoFields) return;
  const mongoUpdate: Record<string, any> = {};
  for (const [zohoKey, val] of Object.entries(zohoFields)) {
    const mongoKey = ZOHO_TO_MONGO_PRD_FIELD_MAP[zohoKey];
    if (mongoKey !== undefined) mongoUpdate[mongoKey] = val;
  }
  if (Object.keys(mongoUpdate).length === 0) return; // nothing PRD-relevant
  mongoUpdate.updated_at = new Date().toISOString();
  try {
    const col = await getCollection<LeadDoc>(COL.LEADS);
    // Match on zoho_lead_id — Mongo doc exists from initial ingest.
    // upsert:false so we don't create orphan docs if zoho_lead_id has no
    // matching Mongo lead (e.g., LeadChain leads created direct in Zoho
    // without going through our ingest path).
    await col.updateOne(
      { zoho_lead_id: zohoLeadId },
      { $set: mongoUpdate },
      { upsert: false },
    );
  } catch (err: any) {
    // Never block the caller's main flow (Zoho update already succeeded).
    console.error(`[mirrorLeadStateToMongo] zoho_lead_id=${zohoLeadId} failed: ${err.message}`);
  }
}

// ─── FULL Zoho lead -> Mongo sync (for in-house CRM source-of-truth) ────────
//
// PURELY ADDITIVE. This does NOT touch any bot/call/WhatsApp/followup logic —
// it only copies a Zoho lead record into the Mongo `leads` collection so the
// in-house CRM (and, later, the bot) can read everything from Mongo.
//
// Differences vs mirrorLeadStateToMongo (which is whitelist + upsert:false):
//   - upsert:TRUE  → leads created DIRECTLY in Zoho (sales manual / bulk /
//     LeadChain) that never went through our ingest still land in Mongo.
//   - FULL snapshot → every Zoho field is stored under `zoho`, plus the
//     CRM-relevant ones mapped to flat snake_case for easy display.
//
// Existing ingest-created docs (which already carry zoho_lead_id, keyed by
// plid) are matched + merged. Direct-Zoho leads with no Mongo doc get a new
// doc keyed `zoho_<id>` so it never collides with a plid-keyed doc.
/** Pure mapper: Zoho lead → the flat Mongo `leads` doc. No DB access. */
function mapZohoLead(zohoLead: any): Record<string, any> | null {
  const id = zohoLead?.id;
  if (!id) return null;
  const phone = String(zohoLead.Mobile || zohoLead.Phone || "").replace(/\D/g, "");
  const now = new Date().toISOString();
  return {
    zoho_lead_id: id,
    phone,
    first_name: zohoLead.First_Name ?? "",
    last_name: zohoLead.Last_Name ?? "",
    email: zohoLead.Email ?? "",
    project: zohoLead.ASBL_Project ?? "",
    lead_source: zohoLead.Lead_Source ?? null,
    lead_status: zohoLead.Lead_Status ?? null,
    prd_stage: zohoLead.PRD_Stage ?? null,
    prd_status: zohoLead.PRD_Status ?? null,
    prd_last_action: zohoLead.PRD_Last_Action ?? null,
    prd_last_action_time: zohoLead.PRD_Last_Action_Time ?? null,
    chatbot_attempt_count: zohoLead.Chatbot_Attempt_Count ?? null,
    chatbot_follow_up_count: zohoLead.Chatbot_Follow_up_Count ?? null,
    last_intent: zohoLead.Last_Intent ?? null,
    last_whatsapp_at: zohoLead.Last_Whatsapp_At ?? null,
    whatsapp_replied: zohoLead.Whatsapp_Replied ?? null,
    call_status: zohoLead.Call_Status ?? null,
    total_call_duration_secs: zohoLead.Total_Call_Duration_Secs ?? null,
    last_call_at: zohoLead.Last_Call_At ?? null,
    last_recording_url: zohoLead.Last_Recording_URL ?? null,
    next_call_at: zohoLead.Next_Call_At ?? null,
    site_visit_date: zohoLead.Site_Visit_Date ?? null,
    last_customer_response: zohoLead.Last_Customer_Response ?? null,
    created_time: zohoLead.Created_Time ?? null,
    modified_time: zohoLead.Modified_Time ?? null,
    zoho: zohoLead,            // full raw snapshot — nothing is lost
    zoho_synced_at: now,
    updated_at: now,
  };
}

let _leadsIdxEnsured = false;
async function ensureLeadsZohoIndex(col: any): Promise<void> {
  if (_leadsIdxEnsured) return;
  try { await col.createIndex({ zoho_lead_id: 1 }); _leadsIdxEnsured = true; } catch { /* non-fatal */ }
}

/** Full upsert of a single Zoho lead into Mongo `leads`, keyed on zoho_lead_id
 *  (one op, index-backed — no findOne). New leads get a Mongo-generated _id;
 *  existing docs (ingest plid-keyed or prior sync) are matched + updated. */
export async function syncZohoLeadToMongo(
  zohoLead: any,
): Promise<"created" | "updated" | "skipped"> {
  const mapped = mapZohoLead(zohoLead);
  if (!mapped) return "skipped";
  const col = await getCollection<any>(COL.LEADS);
  await ensureLeadsZohoIndex(col);
  const r = await col.updateOne(
    { zoho_lead_id: mapped.zoho_lead_id } as any,
    { $set: mapped },
    { upsert: true },
  );
  return r.upsertedCount ? "created" : "updated";
}

/** Page Zoho leads and full-sync each into Mongo. Shared by the backfill
 *  endpoint and the incremental cron. `since` (ISO) → only modified-since;
 *  omit → full backfill. PURELY ADDITIVE: reads Zoho, writes Mongo, never
 *  touches the bot/call/WhatsApp/followup paths. */
export async function runZohoLeadSync(
  opts: { since?: string; maxPages?: number } = {},
): Promise<{ pages: number; scanned: number; created: number; updated: number; skipped: number; ms: number; errors: string[] }> {
  const t0 = Date.now();
  const { getAccessToken } = await import("./zoho");
  const token = await getAccessToken();
  const col = await getCollection<any>(COL.LEADS);
  await ensureLeadsZohoIndex(col);   // index on zoho_lead_id so upserts are fast
  const ZBASE = "https://www.zohoapis.in/crm/v3";
  const FIELDS = [
    "id","First_Name","Last_Name","Mobile","Phone","Email","ASBL_Project",
    "Lead_Source","Lead_Status","Created_Time","Modified_Time",
    "PRD_Stage","PRD_Status","PRD_Last_Action","PRD_Last_Action_Time",
    "Chatbot_Attempt_Count","Chatbot_Follow_up_Count","Last_Intent",
    "Last_Whatsapp_At","Whatsapp_Replied","Call_Status",
    "Total_Call_Duration_Secs","Last_Call_At","Last_Recording_URL",
    "Next_Call_At","Site_Visit_Date","Last_Customer_Response",
    "Last_Inhouse_Call_ID","Last_Arrowhead_Call_ID","Budget","Lead_Comments",
  ].join(",");
  const since = opts.since || "";
  const maxPages = Math.min(opts.maxPages || 60, 200);
  let page = 1, created = 0, updated = 0, skipped = 0, scanned = 0;
  const errors: string[] = [];
  while (page <= maxPages) {
    const url = since
      ? `${ZBASE}/Leads/search?criteria=${encodeURIComponent(`(Modified_Time:greater_equal:${since})`)}&fields=${FIELDS}&page=${page}&per_page=200`
      : `${ZBASE}/Leads?fields=${FIELDS}&page=${page}&per_page=200&sort_by=Modified_Time&sort_order=desc`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    if (r.status === 204) break;
    if (!r.ok) { errors.push(`page ${page}: ${r.status} ${(await r.text()).slice(0, 120)}`); break; }
    const text = await r.text();
    if (!text.trim()) break;
    let data: any = null;
    try { data = JSON.parse(text); } catch { break; }
    const rows = (data?.data || []) as any[];
    // Build ONE bulk upsert per page (index-backed on zoho_lead_id) instead of
    // 2 sequential Mongo round-trips per lead. This is the fix for the mongo-sync
    // cron hitting the 300s Vercel timeout (~12k sequential ops → ~280s).
    const ops: any[] = [];
    for (const row of rows) {
      scanned++;
      const mapped = mapZohoLead(row);
      if (!mapped) { skipped++; continue; }
      ops.push({ updateOne: { filter: { zoho_lead_id: mapped.zoho_lead_id }, update: { $set: mapped }, upsert: true } });
    }
    if (ops.length) {
      try {
        const bw = await col.bulkWrite(ops, { ordered: false });
        created += bw.upsertedCount || 0;
        updated += (bw.matchedCount || 0);
      } catch (e: any) { errors.push(`bulk page ${page}: ${e.message}`); }
    }
    if (!data?.info?.more_records) break;
    // Safety net: never approach the 300s serverless cap — stop paging at ~120s
    // (the incremental window picks up the rest on the next run).
    if (Date.now() - t0 > 120_000) { errors.push(`time-budget stop at page ${page}`); break; }
    page++;
  }
  return { pages: page, scanned, created, updated, skipped, ms: Date.now() - t0, errors: errors.slice(0, 10) };
}
