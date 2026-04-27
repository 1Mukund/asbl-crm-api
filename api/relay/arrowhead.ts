import { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";
import { triggerBlueprintTransition } from "../_utils/zoho";

const ARROWHEAD_API_URL =
  "https://api.agent.arrowhead.team/api/v2/public/domain/932f86fc-ed03-42d5-a127-7dfc63216a8a/campaign/a0a15c01-2aa2-40b3-9e46-94109131b17b/schedule";

const ARROWHEAD_BEARER_TOKEN =
  process.env.ARROWHEAD_BEARER_TOKEN ||
  "1928b882dbd4e043fcc61be27aa6eec00b925c1b5cdc4af592a623399571119a";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Extract _zoho_lead_id injected by Deluge — strip before forwarding to Arrowhead
    const { _zoho_lead_id, ...arrowheadPayload } = req.body ?? {};

    const response = await axios.post(ARROWHEAD_API_URL, arrowheadPayload, {
      headers: {
        Authorization: `Bearer ${ARROWHEAD_BEARER_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    // ── Blueprint: move lead to "Lead Initiated" as soon as call is scheduled ──
    if (_zoho_lead_id) {
      triggerBlueprintTransition(_zoho_lead_id, "Lead Initiated").catch((err) =>
        console.error("Blueprint 'Lead Initiated' failed:", err.message)
      );
    } else {
      console.warn("Arrowhead relay: _zoho_lead_id not provided — skipping blueprint transition");
    }

    return res.status(200).json(response.data);
  } catch (err: any) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("Arrowhead relay error:", data);
    return res.status(status).json({ error: data });
  }
}
