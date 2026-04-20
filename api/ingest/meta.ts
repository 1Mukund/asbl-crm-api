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

function parseFieldData(fieldData: Array<{ name: string; values: string[] }>): Record<string, string> {
  const fields: Record<string, string> = {};
  if (Array.isArray(fieldData)) {
    for (const f of fieldData) {
      fields[f.name] = f.values?.[0] ?? "";
    }
  }
  return fields;
}

// ─── Build NormalizedLead from Meta data ─────────────────────────────────────

function buildNormalizedLead(data: Record<string, any>): NormalizedLead | null {
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
    lead_received_at: data.created_time
      ? new Date(data.created_time * 1000).toISOString()
      : new Date().toISOString(),
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

    // ── Format A: Native Meta Webhook ─────────────────────────────────────────
    // Meta sends: { object: "page", entry: [{ changes: [{ value: { leadgen_id, page_id, ... } }] }] }
    if (body.object === "page" && Array.isArray(body.entry)) {
      const results = [];
      const errors  = [];

      for (const entry of body.entry) {
        for (const change of (entry.changes ?? [])) {
          if (change.field !== "leadgen") continue;

          const leadgenId = change.value?.leadgen_id;
          if (!leadgenId) continue;

          try {
            // Fetch full lead data from Graph API
            const leadData = await fetchMetaLeadData(String(leadgenId));

            const lead = buildNormalizedLead(leadData);
            if (!lead) {
              errors.push({ leadgen_id: leadgenId, error: "Invalid or missing phone number" });
              continue;
            }

            const result = await ingestLead(lead);
            results.push({ leadgen_id: leadgenId, ...result });
          } catch (err: any) {
            console.error(`Error processing leadgen_id ${leadgenId}:`, err.message);
            errors.push({ leadgen_id: leadgenId, error: err.message });
          }
        }
      }

      return res.status(200).json({
        success: true,
        processed: results.length,
        errors: errors.length,
        results,
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
