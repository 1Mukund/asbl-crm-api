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

// ─── MLID / PLID Generation ──────────────────────────────────────────────────

export async function getOrCreateMLID(phone: string): Promise<string> {
  const token = await getAccessToken();

  // Search any lead with this phone
  const existing = await findLeadByPhone(phone);
  if (existing?.Master_Lead_ID) return existing.Master_Lead_ID;

  // Get max MLID from all leads
  try {
    const res = await axios.get(`${ZOHO_API_BASE}/Leads`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
      params: { fields: "Master_Lead_ID", per_page: 200, sort_by: "id", sort_order: "desc" },
    });

    const leads = res.data?.data ?? [];
    let max = 1000;
    for (const l of leads) {
      const val = parseInt(l.Master_Lead_ID ?? "0");
      if (!isNaN(val) && val > max) max = val;
    }
    return String(max + 1);
  } catch {
    return "1001";
  }
}

export async function generatePLID(mlid: string, project: string): Promise<string> {
  return `${mlid}-${project}`;
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
  await axios.patch(
    `${ZOHO_API_BASE}/Leads`,
    { data: [{ id, ...data }] },
    { headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" } }
  );
}
