/**
 * Inncircles M1 lead intake webhook.
 *
 *   POST /api/ingest/inncircles
 *
 * New lead source added 2026-05-26. Inncircles M1 (their CRM / form
 * platform) POSTs a lead here; we normalise it, mint a unique MLID + PLID
 * via the same Mongo-backed atomic counters used by Website / FIM / Meta
 * (so identity is consistent across every source), upsert into the Mongo
 * `leads` collection + Zoho, then fire the PRD T=0 fanout (chatbot WhatsApp
 * + AI call) exactly like the other sources.
 *
 * Field mapping is intentionally forgiving — Inncircles may send any of a
 * few common key names. If they add fields later, extend buildLead() and
 * the NormalizedLead type. Unknown extras are ignored.
 *
 * Auth: optional shared secret. If INNCIRCLES_WEBHOOK_SECRET is set in env,
 * the caller must pass it as ?secret= or header x-webhook-secret. If the
 * env var is unset, the endpoint is open (same posture as website.ts) so
 * Inncircles can start sending immediately; tighten later by setting the env.
 */
import { VercelRequest, VercelResponse } from "@vercel/node";
import { normalizePhone, parseName, detectProject } from "../_utils/normalize";
import { ingestLead } from "../_utils/ingest";
import { NormalizedLead } from "../_utils/types";

const LEAD_SOURCE = "Inncircles M1";

/** Pull the first non-empty value across a list of candidate keys. */
function pick(body: any, ...keys: string[]): string {
  for (const k of keys) {
    const v = body?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function buildLead(body: any): NormalizedLead | null {
  const rawPhone = pick(body, "phone", "mobile", "phone_number", "Mobile", "Phone", "contact_number", "contactNumber");
  const mobile = normalizePhone(rawPhone);
  if (!mobile) return null;

  const fullName = pick(body, "name", "full_name", "fullName", "customer_name", "customerName")
    || `${pick(body, "first_name", "firstName")} ${pick(body, "last_name", "lastName")}`.trim();
  const { first_name, last_name } = parseName(fullName);

  const project =
    detectProject(pick(body, "project", "project_name", "projectName")) ??
    detectProject(pick(body, "campaign", "campaign_name", "utm_campaign")) ??
    detectProject(pick(body, "page_url", "pageUrl")) ??
    undefined;

  return {
    first_name,
    last_name,
    mobile,
    email: pick(body, "email", "Email", "email_address"),
    lead_source: LEAD_SOURCE,
    source_lead_id: pick(body, "lead_id", "leadId", "id", "m1_lead_id", "inncircles_id", "submission_id"),
    campaign_name: pick(body, "campaign", "campaign_name", "utm_campaign"),
    utm_source: pick(body, "utm_source") || "inncircles",
    utm_medium: pick(body, "utm_medium"),
    utm_campaign: pick(body, "utm_campaign", "campaign", "campaign_name"),
    utm_content: pick(body, "utm_content"),
    utm_term: pick(body, "utm_term"),
    lead_received_at: new Date().toISOString(),
    project,
    budget: pick(body, "budget", "lead_budget", "Lead_Budget"),
    size_preference: pick(body, "size_preference", "configuration", "size", "unit_size"),
    floor_preference: pick(body, "floor_preference", "floor"),
    possession_timeline: pick(body, "possession_timeline", "timeline", "possession"),
    purchase_purpose: pick(body, "purpose", "purchase_purpose"),
    lead_comments: [
      pick(body, "message", "comments", "remarks", "notes"),
      pick(body, "preferred_time", "preferredTime") ? `Preferred time: ${pick(body, "preferred_time", "preferredTime")}` : "",
    ].filter(Boolean).join(" | "),
    first_page_visited: pick(body, "first_page_visited", "page_url", "pageUrl"),
    last_page_visited: pick(body, "last_page_visited"),
    total_page_views: Number(pick(body, "total_page_views", "page_views")) || 0,
    time_spent_minutes: Number(pick(body, "time_spent", "time_spent_minutes")) || 0,
    referrer_url: pick(body, "referrer", "referrer_url"),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Optional shared-secret gate (only enforced when the env var is set).
  const expectedSecret = process.env.INNCIRCLES_WEBHOOK_SECRET || "";
  if (expectedSecret) {
    const got = (req.query.secret as string) || (req.headers["x-webhook-secret"] as string) || "";
    if (got !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — invalid or missing webhook secret" });
    }
  }

  try {
    const body = req.body || {};

    // Support both a single lead object and a batch ({ leads: [...] }).
    const items: any[] = Array.isArray(body?.leads) ? body.leads
      : Array.isArray(body) ? body
      : [body];

    const results: any[] = [];
    for (const item of items) {
      const lead = buildLead(item);
      if (!lead) {
        results.push({ status: "skipped", reason: "invalid or missing phone", raw_phone: item?.phone ?? item?.mobile ?? null });
        continue;
      }
      try {
        const result = await ingestLead(lead);

        // PRD v1.0 T=0 — fire chatbot WhatsApp + AI call on fresh creates only.
        // MUST await — Vercel kills the worker on handler return, so fire-and-
        // forget (.catch without await) silently dies mid-flight. Confirmed
        // by lead 1288576000002161053 (mahee/BROADWAY, 2026-06-05) where
        // Chatbot_Attempt_Count never incremented despite the lead being
        // ingested. Adds ~3-7s to response, well under Inncircles' 44s timeout.
        if (result.action === "created") {
          try {
            const { handleLeadCreated } = await import("../_utils/prd_orchestrator");
            await handleLeadCreated({
              zoho_lead_id: result.zoho_lead_id,
              phone: lead.mobile,
              customer_name: `${lead.first_name} ${lead.last_name}`.replace(/\s+\.$/, "").trim() || "there",
              project: lead.project,
              is_resubmission: false,
              last_page_visited: lead.last_page_visited,
              budget: lead.budget,
              size_preference: lead.size_preference,
            });
          } catch (err: any) {
            console.error(`[Inncircles→PRD] handleLeadCreated failed: ${err.message}`);
          }
        }

        results.push({
          status: "ok",
          action: result.action,
          phone: lead.mobile,
          name: `${lead.first_name} ${lead.last_name}`.trim(),
          project: lead.project || null,
          mlid: result.mlid,
          plid: result.plid,
          zoho_lead_id: result.zoho_lead_id,
        });
      } catch (err: any) {
        console.error(`[Inncircles] ingest failed for ${lead.mobile}: ${err.message}`);
        results.push({ status: "error", phone: lead.mobile, error: err.message });
      }
    }

    const created = results.filter((r) => r.action === "created").length;
    const updated = results.filter((r) => r.action === "updated").length;
    return res.status(200).json({
      success: true,
      source: LEAD_SOURCE,
      received: items.length,
      created,
      updated,
      results,
    });
  } catch (err: any) {
    console.error("[Inncircles] webhook error:", err.message);
    return res.status(500).json({
      error: err.message,
      hint: "Check Vercel env vars: ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, MONGO_URI",
    });
  }
}
