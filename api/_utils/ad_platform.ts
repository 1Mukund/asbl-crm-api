/**
 * Ad-platform feedback — spec section 15.
 * Single entrypoint fireAdEvent() that posts to Meta CAPI + Google OCI.
 *
 * Per spec, every meaningful state transition fires:
 *   - lead_qualified           → Lead_Tier becomes Hot
 *   - site_visit_scheduled     → Stage → Site Visit Scheduled
 *   - site_visit_completed     → Stage → Site Visit Done
 *   - booking_token_paid       → Stage → Booked  (HIGHEST VALUE)
 *   - lost                     → Stage → Closed with negative reason
 *
 * This is THE most-skipped section in real implementations and the
 * MOST important for unit economics. Without this loop, the ad
 * campaigns train on form-fills (cheap signal) rather than bookings
 * (the real outcome we care about).
 *
 * Credentials needed (env vars):
 *   META_PIXEL_ID                 — Pixel/dataset ID for the page
 *   META_CAPI_ACCESS_TOKEN        — Conversions API access token
 *   META_CAPI_TEST_EVENT_CODE     — Optional, for Test Events tab in Events Manager
 *   GOOGLE_ADS_CUSTOMER_ID        — 10-digit customer ID without dashes
 *   GOOGLE_ADS_DEVELOPER_TOKEN    — Google Ads developer token
 *   GOOGLE_ADS_OAUTH_REFRESH_TOKEN — OAuth refresh token (offline)
 *   GOOGLE_ADS_OAUTH_CLIENT_ID    — OAuth app client ID
 *   GOOGLE_ADS_OAUTH_CLIENT_SECRET — OAuth app client secret
 *   GOOGLE_OCI_CONVERSION_ACTION_LEAD_QUALIFIED        — conversionActions/<id>
 *   GOOGLE_OCI_CONVERSION_ACTION_SITE_VISIT_SCHEDULED  — same
 *   GOOGLE_OCI_CONVERSION_ACTION_SITE_VISIT_COMPLETED  — same
 *   GOOGLE_OCI_CONVERSION_ACTION_BOOKING_TOKEN_PAID    — same
 *   GOOGLE_OCI_CONVERSION_ACTION_LOST                  — same
 *
 * Without credentials, fireAdEvent() logs "would have fired" but doesn't
 * actually POST — failsafe so missing config doesn't break the state
 * machine.
 */
import { createHash } from "crypto";
import { getProjectAsp } from "./lead_scoring";

export type AdEventType =
  | "lead_qualified"
  | "site_visit_scheduled"
  | "site_visit_completed"
  | "booking_token_paid"
  | "lost";

// Meta CAPI event_name mapping (spec section 15.1)
const META_EVENT_NAMES: Record<AdEventType, string> = {
  lead_qualified:        "Lead",
  site_visit_scheduled:  "Schedule",
  site_visit_completed:  "ViewContent",
  booking_token_paid:    "Purchase",
  lost:                  "",  // Meta uses negative audiences for lost; no event_name
};

// Google OCI uses conversion action IDs from env (set per event type)
function googleConversionActionFor(eventType: AdEventType): string {
  const map: Record<AdEventType, string> = {
    lead_qualified:       process.env.GOOGLE_OCI_CONVERSION_ACTION_LEAD_QUALIFIED || "",
    site_visit_scheduled: process.env.GOOGLE_OCI_CONVERSION_ACTION_SITE_VISIT_SCHEDULED || "",
    site_visit_completed: process.env.GOOGLE_OCI_CONVERSION_ACTION_SITE_VISIT_COMPLETED || "",
    booking_token_paid:   process.env.GOOGLE_OCI_CONVERSION_ACTION_BOOKING_TOKEN_PAID || "",
    lost:                 process.env.GOOGLE_OCI_CONVERSION_ACTION_LOST || "",
  };
  return map[eventType];
}

// SHA256 hash for user data (Meta + Google both require)
function sha256(input: string): string {
  return createHash("sha256").update(input.trim().toLowerCase()).digest("hex");
}

// Normalise phone for hashing: digits only, with country code
function normalizePhoneForHash(phone: string | null | undefined): string {
  if (!phone) return "";
  return String(phone).replace(/\D/g, "");
}

// Normalise email: lowercase + trim
function normalizeEmailForHash(email: string | null | undefined): string {
  if (!email) return "";
  return String(email).trim().toLowerCase();
}

// Build Meta's "fbc" cookie format from FBCLID + first-seen
function buildFbc(fbclid: string | null | undefined, firstSeenAt: string | null | undefined): string | undefined {
  if (!fbclid) return undefined;
  const ts = firstSeenAt
    ? Math.floor(new Date(firstSeenAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  return `fb.1.${ts}.${fbclid}`;
}

export interface AdEventLead {
  zoho_lead_id: string;
  Phone?: string;
  Mobile?: string;
  Email?: string;
  FBCLID?: string;
  GCLID?: string;
  WBRAID?: string;
  GBRAID?: string;
  First_Seen_At?: string;
  IP_Country?: string;
  ASBL_Project?: string;
  Lead_Tier?: string;
  Predicted_Value_INR?: number;
  Booking_Amount?: number;
}

export interface AdEventResult {
  meta_capi: { fired: boolean; status?: number; response?: any; skipped_reason?: string };
  google_oci: { fired: boolean; status?: number; response?: any; skipped_reason?: string };
}

// ─── Meta CAPI sender ────────────────────────────────────────────────────

async function sendToMetaCapi(eventType: AdEventType, lead: AdEventLead): Promise<{ fired: boolean; status?: number; response?: any; skipped_reason?: string }> {
  const pixelId = process.env.META_PIXEL_ID || "";
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN || "";
  if (!pixelId || !accessToken) {
    return { fired: false, skipped_reason: "META_PIXEL_ID or META_CAPI_ACCESS_TOKEN not configured" };
  }
  if (eventType === "lost") {
    // Meta doesn't have a direct "lost" event; we skip Meta for lost
    // (Google handles it for negative-audience purposes).
    return { fired: false, skipped_reason: "lost_event_not_for_meta" };
  }

  const phone = normalizePhoneForHash(lead.Phone || lead.Mobile);
  const email = normalizeEmailForHash(lead.Email);
  const eventName = META_EVENT_NAMES[eventType];
  const eventTime = Math.floor(Date.now() / 1000);
  const eventId = `${lead.zoho_lead_id}_${eventType}_${eventTime}`;

  // Value: use actual Booking_Amount for booking_token_paid, else Predicted_Value_INR
  const value =
    eventType === "booking_token_paid"
      ? (lead.Booking_Amount || lead.Predicted_Value_INR || getProjectAsp(lead.ASBL_Project))
      : (lead.Predicted_Value_INR || 0);

  const userData: Record<string, any> = {};
  if (phone) userData.ph = [sha256(phone)];
  if (email) userData.em = [sha256(email)];
  const fbc = buildFbc(lead.FBCLID, lead.First_Seen_At);
  if (fbc) userData.fbc = fbc;
  if (lead.IP_Country) userData.country = String(lead.IP_Country).toLowerCase();

  const body: any = {
    data: [{
      event_name: eventName,
      event_time: eventTime,
      event_id: eventId,
      action_source: "system_generated",
      user_data: userData,
      custom_data: {
        value,
        currency: "INR",
        content_name: lead.ASBL_Project ? `${lead.ASBL_Project} Lead` : "ASBL Lead",
        content_category: "real_estate",
        lead_tier: lead.Lead_Tier,
        project: lead.ASBL_Project,
      },
    }],
  };
  const testCode = process.env.META_CAPI_TEST_EVENT_CODE;
  if (testCode) body.test_event_code = testCode;

  try {
    const r = await fetch(
      `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = await r.json().catch(() => ({}));
    return { fired: r.ok, status: r.status, response: data };
  } catch (err: any) {
    return { fired: false, skipped_reason: `meta_capi_threw: ${err.message}` };
  }
}

// ─── Google OCI sender ───────────────────────────────────────────────────
// Uses Google Ads API v17 :uploadOfflineUserData.
// Requires OAuth bearer token (refreshed from refresh_token).

let cachedGoogleToken: { token: string; expiresAt: number } | null = null;

async function getGoogleAccessToken(): Promise<string | null> {
  if (cachedGoogleToken && Date.now() < cachedGoogleToken.expiresAt - 60_000) {
    return cachedGoogleToken.token;
  }
  const refreshToken = process.env.GOOGLE_ADS_OAUTH_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_ADS_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) return null;
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    cachedGoogleToken = {
      token: j.access_token,
      expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
    };
    return cachedGoogleToken.token;
  } catch {
    return null;
  }
}

async function sendToGoogleOci(eventType: AdEventType, lead: AdEventLead): Promise<{ fired: boolean; status?: number; response?: any; skipped_reason?: string }> {
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID || "";
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
  const conversionAction = googleConversionActionFor(eventType);
  if (!customerId || !developerToken || !conversionAction) {
    return { fired: false, skipped_reason: `google_oci_config_missing (customer=${!!customerId}, devtoken=${!!developerToken}, action=${!!conversionAction})` };
  }
  const accessToken = await getGoogleAccessToken();
  if (!accessToken) {
    return { fired: false, skipped_reason: "google_oci_oauth_token_unavailable" };
  }

  const phone = normalizePhoneForHash(lead.Phone || lead.Mobile);
  const email = normalizeEmailForHash(lead.Email);
  const value =
    eventType === "booking_token_paid"
      ? (lead.Booking_Amount || lead.Predicted_Value_INR || getProjectAsp(lead.ASBL_Project))
      : (lead.Predicted_Value_INR || 0);

  const userIdentifiers: any[] = [];
  if (phone) userIdentifiers.push({ hashed_phone_number: sha256(phone) });
  if (email) userIdentifiers.push({ hashed_email: sha256(email) });

  // Google's preferred ISO format with TZ offset
  const now = new Date();
  const istOffset = "+05:30";
  const conversionDateTime = `${now.toISOString().slice(0, 10)} ${now.toISOString().slice(11, 19)}${istOffset}`;

  const body = {
    operations: [{
      create: {
        user_identifiers: userIdentifiers,
        transaction_attribute: {
          conversion_action: `customers/${customerId}/conversionActions/${conversionAction}`,
          currency_code: "INR",
          transaction_amount_micros: String(Math.round(value * 1_000_000)),
          transaction_date_time: conversionDateTime,
          gclid: lead.GCLID || undefined,
          wbraid: lead.WBRAID || undefined,
          gbraid: lead.GBRAID || undefined,
        },
      },
    }],
  };

  try {
    const r = await fetch(
      `https://googleads.googleapis.com/v17/customers/${customerId}:uploadOfflineUserData`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "developer-token": developerToken,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      },
    );
    const data = await r.json().catch(() => ({}));
    return { fired: r.ok, status: r.status, response: data };
  } catch (err: any) {
    return { fired: false, skipped_reason: `google_oci_threw: ${err.message}` };
  }
}

// ─── Public entrypoint ───────────────────────────────────────────────────

/**
 * Fire a conversion event to both Meta CAPI and Google OCI.
 * Best-effort: failures are logged but don't throw — state machine
 * transitions must never be blocked by ad-platform failures.
 */
export async function fireAdEvent(
  eventType: AdEventType,
  lead: AdEventLead,
): Promise<AdEventResult> {
  const [meta, google] = await Promise.all([
    sendToMetaCapi(eventType, lead),
    sendToGoogleOci(eventType, lead),
  ]);
  console.log(
    `[AdEvent] ${eventType} for lead ${lead.zoho_lead_id} — ` +
    `meta=${meta.fired ? "OK" : `SKIP(${meta.skipped_reason || meta.status})`} ` +
    `google=${google.fired ? "OK" : `SKIP(${google.skipped_reason || google.status})`}`,
  );
  return { meta_capi: meta, google_oci: google };
}
