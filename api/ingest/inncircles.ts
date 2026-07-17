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

// FALLBACK source only. The webhook now honours a caller-supplied `source`
// in the payload (see buildLead) — whoever hits this endpoint sends its own
// source. This value is used ONLY when the payload omits `source`.
// NOTE: whatever source the caller sends must exist as a Zoho Lead_Source
// picklist option, else Zoho rejects the create/update.
const DEFAULT_SOURCE = "Inncircles M1";

// Sources the code owns — callers must NOT be able to set these via the
// payload. "Manual Reactivation" is assigned ONLY by the reactivation-allowlist
// branch (a caller spoofing it would mislabel a non-allowlisted lead as a
// reactivation and pollute reactivation reporting). Compared case-insensitively.
const RESERVED_SOURCES = new Set(["manual reactivation"]);

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

  // Per-section engagement time. Inncircles sends UPPER_SNAKE keys
  // (HOME_TIMESPENT, …); accept lower/camel variants too. Undefined when
  // absent so we don't write 0 for sources that don't send it.
  const num = (...keys: string[]): number | undefined => {
    const raw = pick(body, ...keys);
    if (raw === "") return undefined;
    const n = Number(raw);
    // Engagement time can't be negative and a day of dwell time can't exceed
    // 24h; reject out-of-range values so bad payloads don't corrupt analytics.
    if (!Number.isFinite(n) || n < 0 || n > 86400) return undefined;
    return n;
  };
  const section_timespent = {
    home:          num("HOME_TIMESPENT", "home_timespent", "homeTimespent"),
    plans:         num("PLANS_TIMESPENT", "plans_timespent", "plansTimespent"),
    price:         num("PRICE_TIMESPENT", "price_timespent", "priceTimespent"),
    location:      num("LOCATION_TIMESPENT", "location_timespent", "locationTimespent"),
    specification: num("SPECIFICATION_TIMESPENT", "specification_timespent", "specificationTimespent"),
    amenities:     num("AMENITIES_TIMESPENT", "amenities_timespent", "amenitiesTimespent"),
    media:         num("MEDIA_TIMESPENT", "media_timespent", "mediaTimespent"),
  };

  // Origin flags (0/1). Undefined when the caller omits the field so a
  // re-ingest / other source doesn't overwrite an existing value.
  const flag = (...keys: string[]): boolean | undefined => {
    const raw = pick(body, ...keys).toLowerCase();
    if (raw === "") return undefined;
    if (["1", "true", "yes", "y"].includes(raw)) return true;
    if (["0", "false", "no", "n"].includes(raw)) return false;
    return undefined;
  };
  const inncircles_flags = {
    is_reactivated:           flag("IsReactivated", "is_reactivated", "isReactivated"),
    is_born_fresh:            flag("IsBorn_Fresh", "IsBornFresh", "is_born_fresh", "isBornFresh"),
    is_born_in_other_project: flag("IsBorn_InOtherProject", "IsBornInOtherProject", "is_born_in_other_project", "isBornInOtherProject"),
    is_bulk_transfer:         flag("IsBulkTransfer", "IsBulk_Transfer", "is_bulk_transfer", "isBulkTransfer"),
  };

  // Caller-supplied source wins, but reserved (code-owned) values are ignored
  // so a caller can't spoof e.g. "Manual Reactivation" — that is set ONLY by
  // the reactivation-allowlist branch in the handler.
  const rawSource = pick(body, "source", "lead_source", "Lead_Source", "lead_source_name");
  const leadSource = (rawSource && !RESERVED_SOURCES.has(rawSource.trim().toLowerCase()))
    ? rawSource
    : DEFAULT_SOURCE;

  return {
    first_name,
    last_name,
    mobile,
    email: pick(body, "email", "Email", "email_address"),
    // Caller-supplied source wins, EXCEPT reserved values (only the code may
    // assign those). Falls back to DEFAULT_SOURCE when omitted or reserved.
    lead_source: leadSource,
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
    section_timespent,
    inncircles_flags,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-webhook-secret");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // API-key gate. Shares ONE key with /api/ingest/website via INGEST_API_KEY
  // (falls back to the endpoint-specific INNCIRCLES_WEBHOOK_SECRET for
  // back-compat). Enforced only when a key is set. Accepts the same forms as
  // the website endpoint plus the legacy webhook-secret header/query.
  const expectedSecret = process.env.INGEST_API_KEY || process.env.INNCIRCLES_WEBHOOK_SECRET || "";
  if (expectedSecret) {
    const authHeader = String(req.headers["authorization"] || "");
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const got = bearer
      || String(req.headers["x-api-key"] || "")
      || String(req.headers["x-webhook-secret"] || "")
      || String(req.query.key || "")
      || String(req.query.secret || "");
    if (got !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized — missing or invalid API key" });
    }
  }

  try {
    const body = req.body || {};

    // Support both a single lead object and a batch ({ leads: [...] }).
    const items: any[] = Array.isArray(body?.leads) ? body.leads
      : Array.isArray(body) ? body
      : [body];

    const { getReactivationEntry } = await import("../_utils/reactivation");

    const results: any[] = [];
    for (const item of items) {
      const lead = buildLead(item);
      if (!lead) {
        results.push({ status: "skipped", reason: "invalid or missing phone", raw_phone: item?.phone ?? item?.mobile ?? null });
        continue;
      }
      // MANUAL REACTIVATION (2026-07): existing customers are re-pushed through
      // this same webhook. If the phone is on the reactivation allowlist, flip
      // the source Inncircles M1 -> Manual Reactivation so Zoho reflects the
      // real origin. Call routing / cadence is unchanged (webhook already sends
      // the correct latest project; +30min / 15-per-tick batching still applies).
      let reactivation: any = null;
      // Authoritative default on the reactivation source path: every Inncircles
      // lead sends the flag (false here), so a re-push after the list changes
      // clears any stale true — Zoho patch updates don't clear omitted fields.
      lead.reactivation_is_latest = false;
      try {
        const entry = await getReactivationEntry(lead.mobile);
        if (entry) {
          lead.lead_source = "Manual Reactivation";
          // Flag the lead whose project == the sheet's latest_project. Drives
          // the Zoho purple-row marker (Reactivation_Is_Latest). A phone can
          // arrive for several projects; only the latest one is flagged true.
          const isLatest = !!(lead.project && entry.latest_project &&
            lead.project.trim().toUpperCase() === entry.latest_project.trim().toUpperCase());
          lead.reactivation_is_latest = isLatest;
          reactivation = { matched: true, is_latest: isLatest, sheet_latest_project: entry.latest_project || null, incoming_project: lead.project || null };
          console.log(`[Inncircles] Reactivation match ${lead.mobile} — source -> Manual Reactivation, is_latest=${isLatest} (sheet_proj=${entry.latest_project || "?"}, incoming_proj=${lead.project || "?"})`);
        }
      } catch (err: any) {
        console.error(`[Inncircles] reactivation check failed for ${lead.mobile}: ${err.message}`);
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
          lead_source: lead.lead_source,
          reactivation: reactivation || undefined,
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
      default_source: DEFAULT_SOURCE,   // per-lead source is in results[].lead_source
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
