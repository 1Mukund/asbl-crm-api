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

export async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  try {
    const res = await axios.post(ZOHO_TOKEN_URL, null, {
      params: {
        grant_type: "refresh_token",
        client_id: ZOHO_CLIENT_ID,
        client_secret: ZOHO_CLIENT_SECRET,
        refresh_token: ZOHO_REFRESH_TOKEN,
      },
    });

    if (!res.data.access_token) {
      throw new Error(`Zoho token error: ${JSON.stringify(res.data)}`);
    }

    cachedToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return cachedToken!;
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho auth failed: ${JSON.stringify(detail)}`);
  }
}

// ─── Lead Search ─────────────────────────────────────────────────────────────

export async function findLeadByArrowheadCallId(callId: string): Promise<any | null> {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads/search`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        criteria: `(Last_Arrowhead_Call_ID:equals:${callId})`,
        fields: "id,First_Name,Last_Name,Mobile,Master_Lead_ID,Project_Lead_ID,ASBL_Project",
      },
    });
    return res.data?.data?.[0] ?? null;
  } catch (err: any) {
    if (err.response?.status === 204) return null;
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho search failed [findByArrowheadCallId]: ${JSON.stringify(detail)}`);
  }
}

export async function findLeadByPhone(phone: string): Promise<any | null> {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads/search`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: {
        criteria: `(Mobile:equals:${phone})`,
        fields: "id,First_Name,Last_Name,Mobile,Master_Lead_ID,Project_Lead_ID,ASBL_Project",
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
        fields: "id,First_Name,Last_Name,Mobile,Master_Lead_ID,Project_Lead_ID,ASBL_Project",
      },
    });
    return res.data?.data?.[0] ?? null;
  } catch (err: any) {
    if (err.response?.status === 204) return null;
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho search failed [findByPhoneAndProject]: ${JSON.stringify(detail)}`);
  }
}


// ─── Create / Update Lead ────────────────────────────────────────────────────

export async function createLead(data: Record<string, any>): Promise<string> {
  const token = await getAccessToken();
  try {
    const res = await axios.post(
      `${ZOHO_API_BASE}/Leads`,
      { data: [data] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
    );
    return res.data?.data?.[0]?.details?.id;
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho createLead failed: ${JSON.stringify(detail)}`);
  }
}

export async function updateLead(id: string, data: Record<string, any>): Promise<void> {
  const token = await getAccessToken();
  try {
    await axios.patch(
      `${ZOHO_API_BASE}/Leads`,
      { data: [{ id, ...data }] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    throw new Error(`Zoho updateLead failed: ${JSON.stringify(detail)}`);
  }
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
    Who_Id:     { id: params.leadId },
    $se_module: "Leads",
  };

  try {
    await axios.post(
      `${ZOHO_API_BASE}/Calls`,
      { data: [callData] },
      { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    const detail = err.response?.data ?? err.message;
    // Log but don't throw — call log failure shouldn't block lead update
    console.error(`Zoho createCallLog failed: ${JSON.stringify(detail)}`);
  }
}
