import { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";
import { normalizePhone, parseName, detectProject } from "../_utils/normalize";
import { ingestLead } from "../_utils/ingest";
import { NormalizedLead } from "../_utils/types";

const GRAPH_API = "https://graph.facebook.com/v19.0";

// ─── Webhook Verification (Meta requires this GET before sending any events) ──

function handleVerification(req: VercelRequest, res: VercelResponse) {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expectedToken = process.env.META_VERIFY_TOKEN || "asbl_meta_verify_2024";
  if (mode === "subscribe" && token === expectedToken) {
    console.log("Meta webhook verified ✅");
    return res.status(200).send(challenge);
  }

  console.warn("Meta webhook verification failed — token mismatch");
  return res.status(403).json({ error: "Verification failed" });
}

// ─── Fetch Lead Data from Graph API (native Meta webhook only) ────────────────

async function fetchMetaLeadData(leadgenId: string): Promise<Record<string, any>> {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token || token === "REPLACE_WITH_YOUR_PAGE_ACCESS_TOKEN") {
    throw new Error("META_PAGE_ACCESS_TOKEN not configured");
  }

  try {
    const res = await axios.get(`${GRAPH_API}/${leadgenId}`, {
      params: {
        fields: "field_data,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id",
        access_token: token,
      },
    });
    return res.data;
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    throw new Error(`Graph API fetch failed for leadgen_id ${leadgenId}: ${JSON.stringify(detail)}`);
  }
}

// ─── Parse Lead Fields ────────────────────────────────────────────────────────

export function parseFieldData(fieldData: Array<{ name: string; values: string[] }>): Record<string, string> {
  const fields: Record<string, string> = {};
  if (Array.isArray(fieldData)) {
    for (const f of fieldData) {
      fields[f.name] = f.values?.[0] ?? "";
    }
  }
  return fields;
}

// ─── Parse Graph API's created_time which arrives as ISO string OR Unix epoch
export function parseLeadTime(t: any): string {
  if (!t) return new Date().toISOString();
  // Number → Unix epoch seconds
  if (typeof t === "number" && isFinite(t)) {
    return new Date(t * 1000).toISOString();
  }
  // Numeric string ("1745837455") → Unix epoch seconds
  if (typeof t === "string" && /^\d{10}$/.test(t.trim())) {
    return new Date(parseInt(t, 10) * 1000).toISOString();
  }
  // ISO string ("2026-04-28T08:30:55+0000") or anything Date can parse
  const d = new Date(t);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ─── Build NormalizedLead from Meta data ─────────────────────────────────────

export function buildNormalizedLead(data: Record<string, any>): NormalizedLead | null {
  const fields = parseFieldData(data.field_data ?? []);

  const rawPhone = fields["phone_number"] || fields["phone"] || data.phone_number || data.phone || "";
  const mobile = normalizePhone(rawPhone);
  if (!mobile) return null;

  const fullName = fields["full_name"] || data.full_name
    || `${data.first_name ?? ""} ${data.last_name ?? ""}`.trim()
    || `${fields["first_name"] ?? ""} ${fields["last_name"] ?? ""}`.trim();
  const { first_name, last_name } = parseName(fullName);

  const campaignName = data.campaign_name || fields["campaign_name"] || "";
  const project = detectProject(campaignName) ?? detectProject(fields["project"]) ?? undefined;

  return {
    first_name,
    last_name,
    mobile,
    email: fields["email"] || data.email || "",
    lead_source: "FIM Forms",
    source_lead_id: data.leadgen_id || data.id || fields["leadgen_id"] || "",
    campaign_name: campaignName,
    ad_set_name: data.adset_name || data.ad_set_name || "",
    ad_name: data.ad_name || "",
    lead_received_at: parseLeadTime(data.created_time),
    project,
    budget: fields["budget"] || "",
    size_preference: fields["size_preference"] || fields["configuration"] || "",
    lead_comments: fields["message"] || fields["comments"] || "",
  };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {

  // ── GET: Meta webhook verification challenge ────────────────────────────────
  if (req.method === "GET") {
    return handleVerification(req, res);
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body;

    // MASTER FREEZE — archive the raw lead, do NOT process (no Mongo/Zoho/fanout).
    // (Meta's GET verify-challenge above is untouched so the webhook stays valid.)
    {
      const { isAutomationFrozen, archiveFrozen } = await import("../_utils/automation_freeze");
      if (await isAutomationFrozen()) {
        await archiveFrozen("ingest:meta", body);
        // HONEST contract: success:false + a machine-readable code so a caller
        // that keys off HTTP status alone (200) doesn't record an archived-but-
        // unprocessed lead as a success. The lead is NOT in Zoho/Mongo yet — it
        // sits in frozen_inbox (30-day TTL) awaiting replay once the freeze lifts.
        return res.status(200).json({ success: false, frozen: true, code: "AUTOMATION_FROZEN", message: "automation frozen — lead archived, not processed" });
      }
    }

    // ── Format A: Native Meta Webhook ─────────────────────────────────────────
    // Meta sends: { object: "page", entry: [{ changes: [{ value: { leadgen_id, form_id, page_id, ... } }] }] }
    if (body.object === "page" && Array.isArray(body.entry)) {
      // Optional comma-separated allowlist of form IDs that should sync to Zoho.
      // If unset/empty, ALL forms on the subscribed page sync. Useful when you
      // want only specific campaigns (e.g. "High Intent" form) to flow into CRM.
      const formAllowlistRaw = process.env.META_FORM_IDS_ALLOWLIST || "";
      const formAllowlist = new Set(
        formAllowlistRaw.split(",").map((s) => s.trim()).filter(Boolean),
      );

      const results: any[] = [];
      const errors: any[]  = [];
      const skipped: any[] = [];

      for (const entry of body.entry) {
        for (const change of (entry.changes ?? [])) {
          if (change.field !== "leadgen") continue;

          const leadgenId = change.value?.leadgen_id;
          const formId    = change.value?.form_id ? String(change.value.form_id) : "";
          if (!leadgenId) continue;

          // Form-allowlist filter — return 200 to Meta but skip processing
          if (formAllowlist.size > 0 && formId && !formAllowlist.has(formId)) {
            console.log(`[Meta] skip leadgen ${leadgenId}: form_id ${formId} not in allowlist`);
            skipped.push({ leadgen_id: leadgenId, form_id: formId, reason: "form_id_not_allowlisted" });
            continue;
          }

          try {
            // Fetch full lead data from Graph API
            const leadData = await fetchMetaLeadData(String(leadgenId));

            const lead = buildNormalizedLead(leadData);
            if (!lead) {
              errors.push({ leadgen_id: leadgenId, error: "Invalid or missing phone number" });
              continue;
            }

            const result = await ingestLead(lead);

            // PRD v1.0: T=0 fanout — fire chatbot + AI call simultaneously
            // only for fresh creates (not resubmissions; resubmission has
            // its own outreach cooldown via api/_utils/resubmission.ts).
            // MUST await — Vercel kills fire-and-forget on handler return.
            if (result.action === "created") {
              try {
                const { handleLeadCreated } = await import("../_utils/prd_orchestrator");
                await handleLeadCreated({
                  zoho_lead_id: result.zoho_lead_id!,
                  phone: lead.mobile,
                  customer_name: `${lead.first_name} ${lead.last_name}`.replace(/\s+\.$/, "").trim() || "there",
                  project: lead.project,
                  is_resubmission: false,
                  last_page_visited: lead.last_page_visited,
                  budget: lead.budget,
                  size_preference: lead.size_preference,
                });
              } catch (err: any) {
                console.error(`[Meta→PRD] handleLeadCreated failed: ${err.message}`);
              }
            }

            results.push({ leadgen_id: leadgenId, form_id: formId, ...result });
          } catch (err: any) {
            console.error(`Error processing leadgen_id ${leadgenId}:`, err.message);
            errors.push({ leadgen_id: leadgenId, error: err.message });
          }
        }
      }

      return res.status(200).json({
        success: true,
        processed: results.length,
        skipped: skipped.length,
        errors: errors.length,
        results,
        ...(skipped.length > 0 ? { skipped_details: skipped } : {}),
        ...(errors.length > 0 ? { error_details: errors } : {}),
      });
    }

    // ── Format B: LeadChain / Direct POST (field_data already present) ─────────
    const lead = buildNormalizedLead(body);
    if (!lead) {
      return res.status(400).json({ error: "Invalid or missing phone number" });
    }

    const result = await ingestLead(lead);
    return res.status(200).json({ success: true, ...result });

  } catch (err: any) {
    console.error("Meta ingest error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
