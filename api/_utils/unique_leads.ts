/**
 * Compute + sync the `Is_Unique_Lead` (boolean) flag on every Zoho lead.
 *
 * Why this field exists: a single human often has N Zoho lead records —
 * one per project they enquired about (BROADWAY, SPECTRA, LOFT...). When
 * sales / marketing wants to count *humans* instead of records, there's
 * no native Zoho filter for "show one row per phone". This field is the
 * fix — set to `true` on exactly one record per phone (the most-recently-
 * modified one) and `false` on the rest. A Zoho Custom View filtered on
 * Is_Unique_Lead = true then renders the deduped list natively.
 *
 * Idempotent: only PATCHes records whose computed value differs from the
 * current value, so re-runs over a stable corpus are no-ops.
 */
import { getAccessToken, updateLead } from "./zoho";

const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";

/** Normalise a phone to a comparable key.
 *  - Strip all non-digit characters
 *  - 10 Indian digits → prepend "91"
 *  - Leading "0" + 10 digits → strip 0, prepend "91"
 *  All of "+919999999999", "9999999999", "09999999999", "919999999999"
 *  collapse to "919999999999" so cross-format dupes match.
 */
export function normPhoneKey(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  return digits;
}

/** Fetch every Zoho lead with the fields we need for dedup decisions.
 *  Sort = Modified_Time desc so the canonical (most-recently-modified)
 *  record is always within the cap. */
export async function fetchAllLeadsForUniqueSync(maxRecords = 5000): Promise<any[]> {
  const token = await getAccessToken();
  const fields = [
    "id", "Mobile",
    "Is_Unique_Lead",
    "ASBL_Project",
    "Modified_Time", "Created_Time",
  ].join(",");

  const out: any[] = [];
  const perPage = 200;
  let page = 1;
  while (out.length < maxRecords) {
    const r = await fetch(
      `${ZOHO_API_BASE}/Leads?fields=${fields}&per_page=${perPage}&page=${page}&sort_by=Modified_Time&sort_order=desc`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (r.status === 204) break;
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Zoho list page ${page} failed: ${r.status} ${text.slice(0, 200)}`);
    }
    const j = await r.json() as any;
    const arr: any[] = j?.data || [];
    if (!arr.length) break;
    out.push(...arr);
    if (!j?.info?.more_records) break;
    page++;
  }
  return out.slice(0, maxRecords);
}

/** Bulk PATCH up to 100 leads per call (Zoho v3 max). Returns the count
 *  of records the server accepted. */
async function bulkPatchUniqueFlag(
  records: Array<{ id: string; value: boolean }>,
): Promise<number> {
  if (!records.length) return 0;
  const token = await getAccessToken();
  let updated = 0;
  for (let i = 0; i < records.length; i += 100) {
    const slice = records.slice(i, i + 100);
    const body = {
      data: slice.map((r) => ({ id: r.id, Is_Unique_Lead: r.value })),
    };
    const r = await fetch(`${ZOHO_API_BASE}/Leads`, {
      method: "PATCH",
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Zoho bulk PATCH slice ${i / 100} failed: ${r.status} ${text.slice(0, 200)}`);
    }
    const j = await r.json() as any;
    const arr: any[] = j?.data || [];
    updated += arr.filter((d: any) => d.status === "success").length;
  }
  return updated;
}

export interface UniqueLeadsSyncResult {
  ms: number;
  total_records: number;
  unique_phones: number;
  duplicate_phones: number;
  to_mark_true: number;
  to_mark_false: number;
  patched_true: number;
  patched_false: number;
  without_phone: number;
  error?: string;
}

/** Main entry point — does one full sweep and PATCHes the diff.
 *  Caller can use this from an admin endpoint or a cron task. */
export async function syncUniqueLeadFlags(): Promise<UniqueLeadsSyncResult> {
  const t0 = Date.now();
  const result: UniqueLeadsSyncResult = {
    ms: 0, total_records: 0, unique_phones: 0, duplicate_phones: 0,
    to_mark_true: 0, to_mark_false: 0, patched_true: 0, patched_false: 0,
    without_phone: 0,
  };

  const leads = await fetchAllLeadsForUniqueSync(5000);
  result.total_records = leads.length;

  // Group by normalised phone
  const byPhone = new Map<string, any[]>();
  for (const l of leads) {
    const phone = normPhoneKey(l.Mobile);
    if (!phone) { result.without_phone++; continue; }
    let arr = byPhone.get(phone);
    if (!arr) { arr = []; byPhone.set(phone, arr); }
    arr.push(l);
  }
  result.unique_phones = byPhone.size;

  const toTrue: Array<{ id: string; value: boolean }> = [];
  const toFalse: Array<{ id: string; value: boolean }> = [];

  byPhone.forEach((arr) => {
    if (arr.length > 1) result.duplicate_phones++;
    // Most recently modified = canonical
    arr.sort((a, b) =>
      new Date(b.Modified_Time || 0).getTime() - new Date(a.Modified_Time || 0).getTime(),
    );
    const master = arr[0];
    const others = arr.slice(1);

    // Only PATCH where the current Zoho value differs from the computed value.
    // Treat undefined/null as "not yet set" → if computed is true, we PATCH it.
    if (master.Is_Unique_Lead !== true) {
      toTrue.push({ id: master.id, value: true });
    }
    for (const o of others) {
      if (o.Is_Unique_Lead === true) {
        toFalse.push({ id: o.id, value: false });
      }
    }
  });

  result.to_mark_true = toTrue.length;
  result.to_mark_false = toFalse.length;
  result.patched_true = await bulkPatchUniqueFlag(toTrue);
  result.patched_false = await bulkPatchUniqueFlag(toFalse);
  result.ms = Date.now() - t0;
  return result;
}

/** Cheap per-phone recompute — used when we just created/updated a lead and
 *  want the flag to settle without waiting for the next cron tick. Looks up
 *  every record for this phone via Zoho search, marks the most-recently-
 *  modified one as the master, all others as not-unique. Idempotent.
 *
 *  Returns null on any Zoho failure — caller treats this as best-effort and
 *  swallows so it never blocks the ingest path. */
export async function recomputeUniqueForPhone(phone: string): Promise<{
  master_id: string;
  others_set_false: number;
} | null> {
  const cleaned = String(phone || "").replace(/^\+/, "");
  if (!cleaned) return null;
  const token = await getAccessToken();
  try {
    const r = await fetch(
      `${ZOHO_API_BASE}/Leads/search?` +
      `criteria=(Mobile:equals:${encodeURIComponent(cleaned)})&` +
      `fields=id,Mobile,Is_Unique_Lead,Modified_Time`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } },
    );
    if (r.status === 204) return null;
    if (!r.ok) return null;
    const j = await r.json() as any;
    const arr: any[] = j?.data || [];
    if (!arr.length) return null;
    arr.sort((a, b) =>
      new Date(b.Modified_Time || 0).getTime() - new Date(a.Modified_Time || 0).getTime(),
    );
    const master = arr[0];
    const others = arr.slice(1);

    if (master.Is_Unique_Lead !== true) {
      await updateLead(master.id, { Is_Unique_Lead: true });
    }
    let resetCount = 0;
    for (const o of others) {
      if (o.Is_Unique_Lead === true) {
        await updateLead(o.id, { Is_Unique_Lead: false });
        resetCount++;
      }
    }
    return { master_id: master.id, others_set_false: resetCount };
  } catch {
    return null;
  }
}
