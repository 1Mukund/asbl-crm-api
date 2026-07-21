/**
 * Per-person (per-phone) call / follow-up de-duplication.
 *
 * A single human often has N Zoho lead records — one per project they enquired
 * about (BROADWAY, SPECTRA, LOFT, the new launch...). Without this, the cron +
 * T=0 flow fire calls & proactive follow-ups on EVERY record → the person is
 * called once PER PROJECT. This module picks exactly ONE record per phone (the
 * "primary caller"); the cron + born flow gate all outbound calls + proactive
 * follow-ups on it. The other project records stay silent — but the primary's
 * call carries the OTHER projects as context so the voice agent knows the
 * person enquired about multiple projects and can talk about them.
 *
 * Reactive replies (customer texts in / asks for a callback) are NOT gated by
 * this — those are always answered.
 */
import { normPhoneKey } from "./unique_leads";
import { displayProject } from "./project_detection";
import { isTerminalLeadStatus } from "./prd_state_machine";

/** Phone key for a lead record (Phone falls back to Mobile), normalised so
 *  cross-format dupes collapse. Empty string when there's no usable phone. */
export function leadPhoneKey(lead: any): string {
  return normPhoneKey(String(lead?.Phone || lead?.Mobile || ""));
}

/** Still an active outreach candidate? Mirrors the cron's own skip gates so a
 *  closed / converted / spam record is never chosen as the primary caller. */
export function isOutreachEligible(lead: any): boolean {
  // Lead_Status is the source of truth — a terminal / milestone status (site
  // visit booked, not interested, won, …) means no more outreach, even if
  // PRD_Stage lagged behind it.
  if (isTerminalLeadStatus(lead?.Lead_Status)) return false;
  const stage = String(lead?.PRD_Stage || "");
  if (!stage) return false;
  if (stage === "Not Interested" || stage === "Spam" || stage === "Pre Site Visit") return false;
  return true;
}

/** Has this record already begun an outreach track? Lets us keep calling the
 *  record that "claimed" the phone first instead of hopping between projects. */
export function hasStartedOutreach(lead: any): boolean {
  return !!(
    lead?.Last_Inhouse_Call_ID ||
    lead?.Next_Call_At ||
    Number(lead?.Chatbot_Attempt_Count ?? 0) > 0 ||
    Number(lead?.Chatbot_Follow_up_Count ?? 0) > 0 ||
    Number(lead?.Total_Call_Duration_Secs ?? 0) > 0
  );
}

function createdMs(lead: any): number {
  const t = lead?.Created_Time ? new Date(lead.Created_Time).getTime() : 0;
  return Number.isFinite(t) && t > 0 ? t : Number.MAX_SAFE_INTEGER;
}

/** Pick the ONE primary-caller record for a phone's group of records:
 *    1. only eligible records
 *    2. prefer the one already mid-outreach (stable — don't hop projects)
 *    3. else the earliest-born record
 *  Deterministic + stable so the SAME record is chosen every cron tick (a
 *  wobbling pick would call a different project each tick). Returns null when
 *  no record is eligible (all closed). */
export function pickPrimaryLeadId(records: any[]): string | null {
  const eligible = records.filter(isOutreachEligible);
  if (!eligible.length) return null;
  eligible.sort((a, b) => {
    const sa = hasStartedOutreach(a) ? 0 : 1;
    const sb = hasStartedOutreach(b) ? 0 : 1;
    if (sa !== sb) return sa - sb;                       // already-started first
    const ca = createdMs(a), cb = createdMs(b);
    if (ca !== cb) return ca - cb;                       // else earliest born
    return String(a.id).localeCompare(String(b.id));     // stable tiebreak
  });
  return String(eligible[0].id);
}

/** Distinct OTHER project names for the phone (for calling-agent context),
 *  masked through displayProject so the LEGACY codename never leaks. Excludes
 *  the primary's own project. */
export function otherProjectsForContext(records: any[], excludeProject?: string): string[] {
  const exclude = displayProject(excludeProject, "").trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    const raw = String(r?.ASBL_Project || "").trim();
    if (!raw) continue;
    const disp = displayProject(raw, "").trim();
    if (!disp || disp === exclude || seen.has(disp)) continue;
    seen.add(disp);
    out.push(disp);
  }
  return out;
}

/** Every lead record for a phone — used by the T=0 born flow to check for an
 *  already-active sibling + gather sibling projects. Reads from Mongo FIRST
 *  (avoids a Zoho API search on every new lead — big saving during bulk lead
 *  bursts); falls back to a Zoho search only if Mongo has nothing. The
 *  sibling-check signals it relies on (Last_Inhouse_Call_ID, Chatbot_*,
 *  Total_Call_Duration_Secs, Next_Call_At) are all mirrored to Mongo, so an
 *  active sibling is still detected. Best-effort: [] on total failure. */
export async function fetchLeadRecordsByPhone(phone: string): Promise<any[]> {
  const key = normPhoneKey(phone);
  if (!key) return [];
  try {
    const { getCollection, COL } = await import("./mongo");
    const col = await getCollection<any>(COL.LEADS);
    const docs = await col.find({ mobile: key } as any).limit(50).toArray();
    if (docs.length) {
      // Map Mongo snake_case → the Zoho-cased shape the helpers above read.
      return docs.map((d: any) => ({
        id: d.zoho_lead_id || d._id,
        Mobile: d.mobile,
        ASBL_Project: d.project || d.asbl_project || "",
        Lead_Status: d.lead_status ?? null,
        PRD_Stage: d.prd_stage ?? null,
        Next_Call_At: d.next_call_at ?? null,
        Last_Inhouse_Call_ID: d.last_inhouse_call_id ?? null,
        Chatbot_Attempt_Count: d.chatbot_attempt_count ?? 0,
        Chatbot_Follow_up_Count: d.chatbot_follow_up_count ?? 0,
        Total_Call_Duration_Secs: d.total_call_duration_secs ?? 0,
        Created_Time: d.created_time || d.created_at || null,
      }));
    }
  } catch (err) {
    // fall through to Zoho
  }
  return fetchLeadRecordsByPhoneZoho(phone);
}

/** Zoho-search fallback for fetchLeadRecordsByPhone (leads not yet in Mongo).
 *  Best-effort: returns [] on any Zoho failure so it never blocks ingest. */
async function fetchLeadRecordsByPhoneZoho(phone: string): Promise<any[]> {
  const cleaned = String(phone || "").replace(/^\+/, "").replace(/\D/g, "");
  if (!cleaned) return [];
  try {
    const { getAccessToken } = await import("./zoho");
    const token = await getAccessToken();
    const fields = [
      "id", "Mobile", "Phone", "ASBL_Project", "Lead_Status", "PRD_Stage", "Next_Call_At",
      "Last_Inhouse_Call_ID", "Chatbot_Attempt_Count", "Chatbot_Follow_up_Count",
      "Total_Call_Duration_Secs", "Created_Time", "Master_Lead_ID",
    ].join(",");
    const r = await fetch(
      `https://www.zohoapis.in/crm/v3/Leads/search?criteria=(Mobile:equals:${encodeURIComponent(cleaned)})&fields=${fields}`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (!r.ok) return [];
    const j = await r.json() as any;
    return (j?.data || []) as any[];
  } catch {
    return [];
  }
}

/** One-time (also cron-able) backfill sweep: across ALL leads, for every phone
 *  with >1 record, clear Next_Call_At on the non-primary records so only the
 *  primary keeps its call cadence. Idempotent — only touches records that
 *  actually carry a Next_Call_At. */
export async function dedupCallPrimariesSweep(maxRecords = 6000): Promise<{
  ms: number; total_records: number; phones: number; multi_project_phones: number;
  siblings_cleared: number; errors: number;
}> {
  const t0 = Date.now();
  const { getAccessToken, updateLead } = await import("./zoho");
  const { mirrorLeadStateToMongo } = await import("./supabase");
  const token = await getAccessToken();
  const fields =
    "id,Mobile,Phone,ASBL_Project,Lead_Status,PRD_Stage,Next_Call_At,Last_Inhouse_Call_ID," +
    "Chatbot_Attempt_Count,Chatbot_Follow_up_Count,Total_Call_Duration_Secs,Created_Time";
  const all: any[] = [];
  let page = 1;
  while (all.length < maxRecords) {
    const r = await fetch(
      `https://www.zohoapis.in/crm/v3/Leads?fields=${fields}&per_page=200&page=${page}&sort_by=Modified_Time&sort_order=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (r.status === 204) break;
    if (!r.ok) break;
    const j = await r.json() as any;
    const rows = (j?.data || []) as any[];
    if (!rows.length) break;
    all.push(...rows);
    if (!j?.info?.more_records) break;
    page++;
  }
  const byPhone = new Map<string, any[]>();
  for (const l of all) {
    const k = leadPhoneKey(l);
    if (!k) continue;
    let arr = byPhone.get(k);
    if (!arr) { arr = []; byPhone.set(k, arr); }
    arr.push(l);
  }
  let multi = 0, cleared = 0, errors = 0;
  for (const [, arr] of byPhone) {
    if (arr.length < 2) continue;
    multi++;
    const primaryId = pickPrimaryLeadId(arr);
    for (const l of arr) {
      if (String(l.id) === String(primaryId)) continue;
      if (!l.Next_Call_At) continue;
      try {
        await updateLead(l.id, { Next_Call_At: null });
        await mirrorLeadStateToMongo(l.id, { Next_Call_At: null });
        cleared++;
      } catch {
        errors++;
      }
    }
  }
  return {
    ms: Date.now() - t0,
    total_records: all.length,
    phones: byPhone.size,
    multi_project_phones: multi,
    siblings_cleared: cleared,
    errors,
  };
}
