import type { VercelRequest, VercelResponse } from "@vercel/node";
import { NormalizedLead } from "../_utils/types";
import { ingestLead } from "../_utils/ingest";
import { fanoutToNewCrm } from "../_utils/fanout_new_crm";

// ── Normalize Meta phone (p:7842570649 or p:917842570649) ────
function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length > 12) return digits.slice(-12); // take last 12
  return digits;
}

// ── Detect project from campaign / ad / form name ────────────
function detectProject(text: string): string | undefined {
  const t = text.toLowerCase();
  if (t.includes("loft"))     return "LOFT";
  if (t.includes("spectra"))  return "SPECTRA";
  if (t.includes("broadway")) return "BROADWAY";
  if (t.includes("landmark")) return "LANDMARK";
  if (t.includes("legacy"))   return "LEGACY";
  return undefined;
}

// ── Clean Meta budget strings ─────────────────────────────────
function cleanBudget(raw: string): string {
  return raw
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/cr\b/gi, "Cr")
    .trim();
}

// ── Normalize a single Meta CSV row ──────────────────────────
function normalizeMetaRow(row: Record<string, string>): NormalizedLead {
  const fullName = (row["full_name"] || "").trim();
  const nameParts = fullName.split(" ");
  const first_name = nameParts[0] || fullName;
  const last_name = nameParts.slice(1).join(" ") || ".";

  const phone = normalizePhone(row["phone"] || "");

  const campaignName = row["campaign_name"] || "";
  const adName = row["ad_name"] || "";
  const adSetName = row["adset_name"] || "";
  const formName = row["form_name"] || "";

  const project =
    detectProject(campaignName) ||
    detectProject(adName) ||
    detectProject(formName);

  const budget = cleanBudget(row["what_is_your_preffered_budget?"] || row["budget"] || "");
  const size = (row["what_is_your_sft_requirement?"] || row["size"] || "").replace(/_/g, " ").trim();

  return {
    first_name,
    last_name,
    mobile: phone,
    email: row["email"] || undefined,
    lead_source: "FIM Forms",
    source_lead_id: row["id"] || undefined,
    campaign_name: campaignName,
    ad_set_name: adSetName,
    ad_name: adName,
    utm_source: "meta",
    utm_medium: "paid_social",
    utm_campaign: campaignName,
    lead_received_at: row["created_time"] || new Date().toISOString(),
    project,
    budget,
    size_preference: size,
  };
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const body = req.body;

    // MASTER FREEZE — archive the raw lead, do NOT process (no Mongo/Zoho/fanout).
    {
      const { isAutomationFrozen, archiveFrozen } = await import("../_utils/automation_freeze");
      if (await isAutomationFrozen()) {
        await archiveFrozen("ingest:fim", body);
        // HONEST contract: success:false + a machine-readable code so a caller
        // that keys off HTTP status alone (200) doesn't record an archived-but-
        // unprocessed lead as a success. The lead is NOT in Zoho/Mongo yet — it
        // sits in frozen_inbox (30-day TTL) awaiting replay once the freeze lifts.
        return res.status(200).json({ success: false, frozen: true, code: "AUTOMATION_FROZEN", message: "automation frozen — lead archived, not processed" });
      }
    }

    // Accept single row OR array of rows
    const rows: Record<string, string>[] = Array.isArray(body) ? body : [body];
    if (!rows.length) return res.status(400).json({ error: "No leads provided" });

    const results = [];
    for (const row of rows) {
      try {
        const normalized = normalizeMetaRow(row);

        // Skip if phone is invalid (less than 10 digits)
        if (normalized.mobile.replace(/\D/g, "").length < 10) {
          results.push({ source_id: row["id"], status: "skipped", reason: "Invalid phone" });
          continue;
        }

        const result = await ingestLead(normalized);

        // PRD v1.0: T=0 fanout (Website / Meta / FIM all need this — was
        // only wired into Meta before; fix 2026-05-26).
        // MUST await — Vercel kills fire-and-forget on handler return.
        if (result.action === "created") {
          try {
            const { handleLeadCreated } = await import("../_utils/prd_orchestrator");
            await handleLeadCreated({
              zoho_lead_id: result.zoho_lead_id!,
              phone: normalized.mobile,
              customer_name: `${normalized.first_name} ${normalized.last_name}`.replace(/\s+\.$/, "").trim() || "there",
              project: normalized.project,
              is_resubmission: false,
              last_page_visited: normalized.last_page_visited,
              budget: normalized.budget,
              size_preference: normalized.size_preference,
            });
          } catch (err: any) {
            console.error(`[FIM→PRD] handleLeadCreated failed: ${err.message}`);
          }
        }

        results.push({
          source_id: row["id"],
          name: `${normalized.first_name} ${normalized.last_name}`.trim(),
          phone: normalized.mobile,
          project: normalized.project,
          status: "ok",
          action: result.action,
          mlid: result.mlid,
          plid: result.plid,
          zoho_lead_id: result.zoho_lead_id,
        });
      } catch (err: any) {
        results.push({ source_id: row["id"], status: "error", reason: err.message });
      }
    }

    const created = results.filter(r => r.action === "created").length;
    const updated = results.filter(r => r.action === "updated").length;
    const errors  = results.filter(r => r.status === "error").length;

    // DUAL-RUN fan-out: forward the ORIGINAL raw body (single row OR array,
    // exactly as received) to the new Intelligent CRM once, after the freeze
    // check passed and the legacy rows were processed above. Best-effort + gated
    // on NEW_CRM_INGEST_URL/SECRET (inert until set); never throws, never affects
    // the legacy Zoho/Mongo write or this response.
    await fanoutToNewCrm("fim", body);

    return res.json({ summary: { total: rows.length, created, updated, errors }, results });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}
