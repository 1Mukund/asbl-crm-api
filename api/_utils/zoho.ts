import axios from "axios";

const ZOHO_TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token";
const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";

const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
} = process.env;

// ─── Token ───────────────────────────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

// Shared token cache key in Mongo `bot_settings`. The SAME key the Periskope
// webhook uses (getZohoToken) — so the WHOLE app shares ONE Zoho access token
// across every serverless instance and both code paths.
//
// Why this matters (root cause of the ingest INVALID_TOKEN + rate-limit storm):
// each Vercel instance used to mint + cache its OWN token. Under burst ingest
// (100s of leads → many concurrent instances) that (a) issued many tokens so
// Zoho invalidated the older ones → `INVALID_TOKEN` on createLead, and (b)
// hammered the /token endpoint → `Access Denied: too many requests`. A single
// shared token removes both: instances READ the shared token and only ONE
// refresh happens when it actually expires.
const ZOHO_TOKEN_KEY = "zoho_access_token_v1";

export async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();

  // 1. Module cache (warm instance) — skip on a forced refresh.
  if (!forceRefresh && cachedToken && now < tokenExpiry) return cachedToken;

  const failedToken = cachedToken; // the token that was just rejected (forceRefresh)

  // 2. Shared cache in Mongo bot_settings. On a forced refresh, a DIFFERENT
  //    still-valid shared token means another instance already refreshed after
  //    the invalidation → adopt it WITHOUT calling /token (kills the refresh
  //    stampede that caused the rate-limit).
  try {
    const { getBotSetting } = await import("./bot_settings");
    const row = await getBotSetting(ZOHO_TOKEN_KEY);
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      const stillValid = parsed?.token && parsed?.expiry && now < parsed.expiry - 60_000;
      const isDifferent = parsed?.token && parsed.token !== failedToken;
      if (stillValid && (!forceRefresh || isDifferent)) {
        cachedToken = parsed.token;
        tokenExpiry = parsed.expiry;
        return parsed.token;
      }
    }
  } catch {}

  // 3. Refresh from Zoho, then write to BOTH caches. Retry on transient network
  //    errors (ETIMEDOUT / ECONNRESET) — accounts.zoho.in occasionally times out.
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(ZOHO_TOKEN_URL, null, {
        params: {
          grant_type: "refresh_token",
          client_id: ZOHO_CLIENT_ID,
          client_secret: ZOHO_CLIENT_SECRET,
          refresh_token: ZOHO_REFRESH_TOKEN,
        },
        timeout: 8000, // hard 8s timeout instead of axios default
      });
      if (!res.data.access_token) {
        throw new Error(`Zoho token error: ${JSON.stringify(res.data)}`);
      }
      cachedToken = res.data.access_token;
      const expiresInSec = Number(res.data.expires_in) || 3600;
      // Pad by 2 min so we (and the shared cache) never serve a token about to die.
      tokenExpiry = now + (expiresInSec - 120) * 1000;
      // Persist to the shared cache so other instances stop minting their own.
      try {
        const { setBotSetting } = await import("./bot_settings");
        await setBotSetting(ZOHO_TOKEN_KEY, JSON.stringify({ token: cachedToken, expiry: tokenExpiry }));
      } catch {}
      return cachedToken!;
    } catch (err: any) {
      lastErr = err;
      const code = err?.code || "";
      const isTransient =
        code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ENOTFOUND" || err?.message?.includes("timeout");
      if (!isTransient || attempt === 3) break;
      console.warn(`[Zoho auth] transient ${code} on attempt ${attempt} — retrying...`);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  const detail = lastErr?.response?.data ?? lastErr?.message ?? String(lastErr);
  throw new Error(`Zoho auth failed: ${JSON.stringify(detail)}`);
}

// ─── Lead Search ─────────────────────────────────────────────────────────────

export async function findLeadByArrowheadCallId(callId: string): Promise<any | null> {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads/search`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        criteria: `(Last_Arrowhead_Call_ID:equals:${callId})`,
        fields: LEAD_LOOKUP_FIELDS,
      },
    });
    return res.data?.data?.[0] ?? null;
  } catch (err: any) {
    if (err.response?.status === 204) return null;
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho search failed [findByArrowheadCallId]: ${JSON.stringify(detail)}`);
  }
}

/** Look up a lead by Last_Inhouse_Call_ID — precise correlation for the
 *  in-house voice bot's posthook (call_sid from voice-bot trigger response). */
export async function findLeadByInhouseCallId(callId: string): Promise<any | null> {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads/search`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        criteria: `(Last_Inhouse_Call_ID:equals:${callId})`,
        fields: LEAD_LOOKUP_FIELDS,
      },
    });
    return res.data?.data?.[0] ?? null;
  } catch (err: any) {
    if (err.response?.status === 204) return null;
    // If the custom field doesn't exist yet, Zoho throws — fall back gracefully
    const detail = err.response?.data ?? err.message;
    console.warn(`[findLeadByInhouseCallId] non-fatal: ${JSON.stringify(detail).slice(0, 200)}`);
    return null;
  }
}

// Common field list — kept in one place so resubmission tracking stays in
// sync across both lookup helpers. Resubmission_Count/History are read by
// recordResubmission(); Next_Call_At + Call_Status are read by the v3
// posthook scheduler. Consecutive_Missed_Count + Aggressive_Tree_Start_At
// were used by v2 (removed 2026-06-18) — fields still exist in Zoho but
// the scheduler no longer touches them.
const LEAD_LOOKUP_FIELDS =
  "id,First_Name,Last_Name,Mobile,Master_Lead_ID,Project_Lead_ID,ASBL_Project," +
  "Resubmission_Count,Resubmission_History,Last_Resubmission_At,Last_Resubmission_Source," +
  "Next_Call_At,Call_Status,Total_Call_Duration_Secs,Created_Time";

/** Direct-by-ID lookup — no search index lag. Returns the same fields
 *  as findLeadByPhone* so callers can use them interchangeably. */
export async function getLeadById(zohoLeadId: string): Promise<any | null> {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads/${zohoLeadId}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { fields: LEAD_LOOKUP_FIELDS },
    });
    return res.data?.data?.[0] ?? null;
  } catch (err: any) {
    if (err.response?.status === 204 || err.response?.status === 404) return null;
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho getLeadById failed: ${JSON.stringify(detail)}`);
  }
}

export async function findLeadByPhone(phone: string): Promise<any | null> {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads/search`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        criteria: `(Mobile:equals:${phone})`,
        fields: LEAD_LOOKUP_FIELDS,
      },
    });
    return res.data?.data?.[0] ?? null;
  } catch (err: any) {
    if (err.response?.status === 204) return null;
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho search failed [findByPhone]: ${JSON.stringify(detail)}`);
  }
}

export async function findLeadByPhoneAndProject(phone: string, project: string): Promise<any | null> {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads/search`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        criteria: `((Mobile:equals:${phone})and(ASBL_Project:equals:${project}))`,
        fields: LEAD_LOOKUP_FIELDS,
      },
    });
    return res.data?.data?.[0] ?? null;
  } catch (err: any) {
    if (err.response?.status === 204) return null;
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho search failed [findByPhoneAndProject]: ${JSON.stringify(detail)}`);
  }
}


// ─── Blueprint Transition ────────────────────────────────────────────────────

export async function triggerBlueprintTransition(
  leadId: string,
  transitionName: string
): Promise<void> {
  const token = await getAccessToken();
  try {
    // Fetch available transitions for this lead
    const res = await axios.get(
      `${ZOHO_API_BASE}/Leads/${leadId}/actions/blueprint`,
      { headers: { Authorization: `Zoho-oauthtoken ${token}` } }
    );
    const transitions: any[] = res.data?.blueprint?.transitions ?? [];
    const match = transitions.find(
      (t: any) => t.name?.toLowerCase() === transitionName.toLowerCase()
    );
    if (!match) {
      console.log(`Blueprint transition "${transitionName}" not available for lead ${leadId}`);
      return;
    }
    await axios.put(
      `${ZOHO_API_BASE}/Leads/${leadId}/actions/blueprint`,
      { blueprint: [{ transition_id: match.id, data: {} }] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
    );
    console.log(`Blueprint transition "${transitionName}" triggered for lead ${leadId}`);
  } catch (err: any) {
    // Non-fatal — log and continue
    // RECORD_NOT_IN_PROCESS is expected when the lead's current state doesn't
    // match the transition's "from" state (e.g. transition "Call Connected"
    // requires Lead_Status = "Lead Initiated", but lead is already at
    // "Contacted" / "Pre Site"). Quiet warning — not a real failure.
    const detail = err.response?.data;
    if (detail?.code === "RECORD_NOT_IN_PROCESS") {
      console.log(`Blueprint transition "${transitionName}" skipped for lead ${leadId} — lead not in matching state (expected, not an error)`);
      return;
    }
    console.error(`Blueprint transition failed for lead ${leadId}:`, detail ?? err.message);
  }
}

// ─── Create / Update Lead ────────────────────────────────────────────────────

/** True when a Zoho error is an expired/invalid access token — the cached token
 *  was invalidated by Zoho (its concurrent-token cap) before our local TTL
 *  lapsed. Recover by force-refreshing the token and retrying the call once.
 *  This is the fix for the "success but INVALID_TOKEN" ingest failures where
 *  50-60 leads silently never landed in Zoho. */
export function isInvalidTokenError(err: any): boolean {
  if (err?.response?.status === 401) return true;
  const body = err?.response?.data;
  const s = (typeof body === "string" ? body : JSON.stringify(body ?? err?.message ?? "")).toLowerCase();
  return (
    s.includes("invalid_token") ||
    s.includes("invalid oauth token") ||
    s.includes("authentication_failure") ||
    s.includes("oauthtoken")
  );
}

export async function createLead(data: Record<string, any>): Promise<string> {
  // Two attempts: the 2nd force-refreshes the token so an INVALID_TOKEN (Zoho
  // invalidated our cached token before its local TTL) self-heals instead of
  // dropping the lead.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const token = await getAccessToken(attempt === 2);
    try {
      const res = await axios.post(
        `${ZOHO_API_BASE}/Leads`,
        { data: [data] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
      );
      return res.data?.data?.[0]?.details?.id;
    } catch (err: any) {
      if (attempt === 1 && isInvalidTokenError(err)) {
        console.warn("[Zoho createLead] INVALID_TOKEN — force-refreshing token + retrying once");
        continue;
      }
      const detail = err.response?.data ?? err.message;
      throw new Error(`Zoho createLead failed: ${JSON.stringify(detail)}`);
    }
  }
  throw new Error("Zoho createLead failed: token refresh did not recover INVALID_TOKEN");
}

const URL_FIELDS = ["First_Page_Visited", "Last_Page_Visited", "Referrer_URL"];

export async function updateLead(id: string, data: Record<string, any>): Promise<void> {
  // Outer loop: attempt 2 force-refreshes the token to self-heal INVALID_TOKEN.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const token = await getAccessToken(attempt === 2);
    try {
      await axios.patch(
        `${ZOHO_API_BASE}/Leads`,
        { data: [{ id, ...data }] },
        { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
      );
      return;
    } catch (err: any) {
      if (attempt === 1 && isInvalidTokenError(err)) {
        console.warn(`[Zoho updateLead] INVALID_TOKEN for ${id} — force-refreshing token + retrying`);
        continue;
      }
      const detail = err.response?.data ?? err.message;
      // If INVALID_DATA on a URL field, retry without URL fields
      const hasUrlError = Array.isArray(err.response?.data?.data) &&
        err.response.data.data.some((d: any) =>
          d.code === "INVALID_DATA" && URL_FIELDS.includes(d.details?.api_name)
        );
      if (hasUrlError) {
        const cleanData = { ...data };
        URL_FIELDS.forEach(f => delete cleanData[f]);
        console.warn(`Retrying updateLead without URL fields for lead ${id}`);
        try {
          await axios.patch(
            `${ZOHO_API_BASE}/Leads`,
            { data: [{ id, ...cleanData }] },
            { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
          );
          return;
        } catch (retryErr: any) {
          const retryDetail = retryErr.response?.data ?? retryErr.message;
          throw new Error(`Zoho updateLead failed (retry): ${JSON.stringify(retryDetail)}`);
        }
      }
      throw new Error(`Zoho updateLead failed: ${JSON.stringify(detail)}`);
    }
  }
  throw new Error(`Zoho updateLead failed: token refresh did not recover INVALID_TOKEN for ${id}`);
}

// ─── Create Call Log (Calls module — shows in lead detail view) ──────────────
export async function createCallLog(params: {
  leadId:          string;
  leadName:        string;
  externalId:      string;  // e.g. "1012-LOFT-1-call-2"
  callStatus:      string;  // Zoho picklist value e.g. "Connected"
  durationSecs:    number;
  transcription?:  string;
  recordingUrl?:   string;
}): Promise<void> {
  const token = await getAccessToken();

  // Format duration as HH:MM:SS for Zoho
  const h = Math.floor(params.durationSecs / 3600);
  const m = Math.floor((params.durationSecs % 3600) / 60);
  const s = params.durationSecs % 60;
  const durationStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;

  // Build description: transcription + recording link
  const descParts: string[] = [];
  if (params.transcription) descParts.push(`📝 Transcription:\n${params.transcription}`);
  if (params.recordingUrl)  descParts.push(`🎙️ Recording:\n${params.recordingUrl}`);
  const description = descParts.join("\n\n") || "";

  const callData: Record<string, any> = {
    Subject:         `Arrowhead Call — ${params.externalId}`,
    Call_Type:       "Outbound",
    Call_Status:     "Completed",
    Call_Result:     params.callStatus,
    Call_Duration:   durationStr,
    Description:     description,
    Call_Start_Time: new Date().toISOString().replace(/\.\d{3}Z$/, "+05:30"),
    // Who_Id linking not supported for Leads in this org — using Notes instead
  };

  try {
    await axios.post(
      `${ZOHO_API_BASE}/Calls`,
      { data: [callData] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    console.error(`Zoho createCallLog failed: ${JSON.stringify(detail)}`);
  }
}

// ─── Create Note on Lead (shows in Notes section + Timeline of lead detail) ──
export async function createCallNote(params: {
  leadId:       string;
  externalId:   string;
  callStatus:   string;
  durationSecs: number;
  transcription?: string;
  recordingUrl?:  string;
}): Promise<void> {
  const token = await getAccessToken();

  const mins = Math.floor(params.durationSecs / 60);
  const secs = params.durationSecs % 60;
  const durStr = `${mins}m ${secs}s`;

  const lines: string[] = [
    `📞 Call ID: ${params.externalId}`,
    `📊 Status: ${params.callStatus}`,
    `⏱️ Duration: ${durStr}`,
  ];
  if (params.recordingUrl)  lines.push(`\n🎙️ Recording:\n${params.recordingUrl}`);
  if (params.transcription) lines.push(`\n📝 Transcription:\n${params.transcription}`);

  const noteData = {
    Note_Title:   `Arrowhead Call — ${params.externalId}`,
    Note_Content: lines.join("\n"),
    Parent_Id:    params.leadId,
    $se_module:   "Leads",
  };

  try {
    await axios.post(
      `${ZOHO_API_BASE}/Notes`,
      { data: [noteData] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
    );
    console.log(`Call note created for lead ${params.leadId}`);
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    console.error(`Zoho createCallNote failed: ${JSON.stringify(detail)}`);
  }
}
