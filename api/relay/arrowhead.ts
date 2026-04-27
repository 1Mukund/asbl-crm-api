import { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";
import { triggerBlueprintTransition, updateLead } from "../_utils/zoho";

const ARROWHEAD_BEARER_TOKEN =
  process.env.ARROWHEAD_BEARER_TOKEN ||
  "1928b882dbd4e043fcc61be27aa6eec00b925c1b5cdc4af592a623399571119a";

const ARROWHEAD_CAMPAIGN_URL_IN =
  process.env.ARROWHEAD_CAMPAIGN_URL_IN ||
  "https://api.agent.arrowhead.team/api/v2/public/domain/932f86fc-ed03-42d5-a127-7dfc63216a8a/campaign/a0a15c01-2aa2-40b3-9e46-94109131b17b/schedule";

const ARROWHEAD_CAMPAIGN_URL_US =
  process.env.ARROWHEAD_CAMPAIGN_URL_US ||
  "https://api.agent.arrowhead.team/api/v2/public/domain/932f86fc-ed03-42d5-a127-7dfc63216a8a/campaign/adcc6884-03d1-4bfa-8b2f-ce4da5ddc527/schedule";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Extract _zoho_lead_id injected by Deluge — strip before forwarding to Arrowhead
    const { _zoho_lead_id, ...arrowheadPayload } = req.body ?? {};

    // Country-based routing (Retell-style for IN, classic for US — both go to same domain, different campaigns)
    const rawPhone = String(arrowheadPayload?.phone_number || arrowheadPayload?.mobile_number || "").replace(/\D/g, "");
    let targetUrl: string;
    let region: string;
    if (rawPhone.startsWith("91")) {
      targetUrl = ARROWHEAD_CAMPAIGN_URL_IN;
      region = "IN";
    } else if (rawPhone.startsWith("1")) {
      targetUrl = ARROWHEAD_CAMPAIGN_URL_US;
      region = "US";
    } else {
      return res.status(400).json({ error: `Unsupported country code for phone: ${rawPhone}` });
    }

    console.log(`[Arrowhead Relay] Routing ${rawPhone} → ${region} campaign`);

    const response = await axios.post(targetUrl, arrowheadPayload, {
      headers: {
        Authorization: `Bearer ${ARROWHEAD_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    // ── Move lead to "Lead Initiated" as soon as call is scheduled ──────────
    // There is no "Lead Initiated" blueprint transition (it's a state, not a transition).
    // We directly update Lead_Status — same approach used by the Zoho Deluge functions.
    // As a fallback we also try the blueprint API in case a transition is added later.
    if (_zoho_lead_id) {
      updateLead(_zoho_lead_id, { Lead_Status: "Lead Initiated" }).catch((err) =>
        console.error("updateLead 'Lead Initiated' failed:", err.message)
      );
      triggerBlueprintTransition(_zoho_lead_id, "Lead Initiated").catch(() => {
        // Silently ignore — no matching transition exists yet in blueprint
      });
    } else {
      console.warn("Arrowhead relay: _zoho_lead_id not provided — skipping Lead Initiated update");
    }

    return res.status(200).json(response.data);
  } catch (err: any) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("Arrowhead relay error:", data);
    return res.status(status).json({ error: data });
  }
}
