/**
 * Lead migration — spec section 4.2.
 *
 * One-time mapping from the legacy Lead_Status values (Fresh, Lead
 * Initiated, Not Interested, etc.) to the spec's canonical Stage +
 * Status fields. Run once after Phase 1 schema lands.
 *
 * Mapping rules (per spec section 4.2 + reasoned inference for the
 * values that exist in our Zoho but aren't in spec):
 *
 *   Lead_Status                  → Stage              | Status
 *   "Fresh" / "NA" / "Not Called"  → New Lead           | Outreach Pending
 *   "Lead Initiated"              → New Lead           | Awaiting Reply
 *   "CF" / "Connected"            → In Conversation    | Talking
 *   "SF" / "No Response"          → In Conversation    | No Response
 *   "CB1"                         → In Conversation    | Callback Pending
 *                                                       + Callback_Source = Customer Requested
 *   "CB2"                         → In Conversation    | Callback Pending
 *                                                       + Callback_Source = System Scheduled
 *   "Pre Site"                    → Site Visit Scheduled | Awaiting Reply
 *   "Virtual Tour"                → Site Visit Done    | Awaiting Reply (post-virtual)
 *   "Not Interested"              → Closed             | Closure_Reason=Not Interested
 *   "Booked"                      → Booked             | (terminal)
 *   "Closed"                      → Closed             | Closure_Reason=Unreachable
 *
 * Best-effort: leads with unknown Lead_Status are left untouched, the
 * sales team can hand-curate them.
 */

const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";

interface MappedLead {
  Stage: string;
  Status: string | null;
  Callback_Source?: string;
  Closure_Reason?: string;
}

export function mapLegacyStatusToSpec(legacyStatus: string | null | undefined): MappedLead | null {
  const s = String(legacyStatus || "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  if (["fresh", "na", "not called", "new"].includes(lower)) {
    return { Stage: "New Lead", Status: "Outreach Pending" };
  }
  if (lower === "lead initiated") {
    return { Stage: "New Lead", Status: "Awaiting Reply" };
  }
  if (["cf", "connected", "contacted"].includes(lower)) {
    return { Stage: "In Conversation", Status: "Talking" };
  }
  if (["sf", "no response", "no answer"].includes(lower)) {
    return { Stage: "In Conversation", Status: "No Response" };
  }
  if (lower === "cb1") {
    return { Stage: "In Conversation", Status: "Callback Pending", Callback_Source: "Customer Requested" };
  }
  if (lower === "cb2") {
    return { Stage: "In Conversation", Status: "Callback Pending", Callback_Source: "System Scheduled" };
  }
  if (lower === "pre site") {
    return { Stage: "Site Visit Scheduled", Status: "Awaiting Reply" };
  }
  if (lower === "virtual tour") {
    return { Stage: "Site Visit Done", Status: "Awaiting Reply" };
  }
  if (lower === "not interested") {
    return { Stage: "Closed", Status: null, Closure_Reason: "Not Interested" };
  }
  if (lower === "booked") {
    return { Stage: "Booked", Status: null };
  }
  if (["closed", "unreachable"].includes(lower)) {
    return { Stage: "Closed", Status: null, Closure_Reason: "Unreachable" };
  }

  return null;
}

/** Run the migration across a batch of leads. Idempotent: leads that
 *  already have a Stage value set are skipped (assume already migrated). */
export async function runLegacyMigration(opts: {
  zohoToken: string;
  /** Optional cap on leads to process. Default 200. */
  max?: number;
  /** Optional offset for paging across multi-run executions. */
  startPage?: number;
}): Promise<{
  scanned: number;
  migrated: number;
  skipped_already_migrated: number;
  skipped_no_mapping: number;
  failed: number;
  errors: any[];
}> {
  const max = Math.min(opts.max ?? 200, 1000);
  const errors: any[] = [];
  let scanned = 0;
  let migrated = 0;
  let skippedAlreadyMigrated = 0;
  let skippedNoMapping = 0;
  let failed = 0;

  let page = opts.startPage ?? 1;
  while (scanned < max) {
    const r = await fetch(
      `${ZOHO_API_BASE}/Leads?` +
        `fields=id,Lead_Status,Stage,Status,Callback_Source,Closure_Reason` +
        `&per_page=100&page=${page}&sort_by=Modified_Time&sort_order=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${opts.zohoToken}` } },
    );
    if (r.status === 204) break;
    if (!r.ok) {
      errors.push({ page, status: r.status, error: (await r.text()).slice(0, 200) });
      break;
    }
    const txt = await r.text();
    if (!txt.trim()) break;
    let data: any = null;
    try { data = JSON.parse(txt); } catch { break; }
    const rows = (data?.data || []) as any[];
    if (!rows.length) break;

    for (const lead of rows) {
      if (scanned >= max) break;
      scanned++;

      // Already migrated? Skip.
      if (lead.Stage) {
        skippedAlreadyMigrated++;
        continue;
      }
      const mapped = mapLegacyStatusToSpec(lead.Lead_Status);
      if (!mapped) {
        skippedNoMapping++;
        continue;
      }

      // Apply mapping via Zoho PATCH
      try {
        const updateBody: any = { id: lead.id, ...mapped };
        // Include audit fields
        const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
        updateBody.Stage_Updated_At = now;
        if (mapped.Status) updateBody.Status_Updated_At = now;
        updateBody.Last_State_Change_Source = "system";
        updateBody.Last_State_Change_Reason = "legacy_migration";
        if (mapped.Stage === "Closed") updateBody.Closed_At = now;

        const ur = await fetch(`${ZOHO_API_BASE}/Leads`, {
          method: "PATCH",
          headers: { Authorization: `Zoho-oauthtoken ${opts.zohoToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ data: [updateBody] }),
        });
        if (!ur.ok) {
          failed++;
          errors.push({ lead_id: lead.id, status: ur.status, error: (await ur.text()).slice(0, 200) });
        } else {
          migrated++;
        }
      } catch (err: any) {
        failed++;
        errors.push({ lead_id: lead.id, error: err.message });
      }
    }
    if (data?.info?.more_records !== true) break;
    page++;
  }

  return {
    scanned,
    migrated,
    skipped_already_migrated: skippedAlreadyMigrated,
    skipped_no_mapping: skippedNoMapping,
    failed,
    errors: errors.slice(0, 20),
  };
}
