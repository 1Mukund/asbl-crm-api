/**
 * GET /api/whatsapp-history?phone=919876543210
 * Returns all WhatsApp messages for a phone number from Supabase
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")    return res.status(405).json({ error: "Method not allowed" });

  const rawPhone = String(req.query.phone || "").replace(/\D/g, "");
  if (!rawPhone || rawPhone.length < 10) {
    return res.status(400).json({ error: "phone query param required" });
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_messages?phone=eq.${rawPhone}&order=created_at.asc&limit=200`,
      {
        headers: {
          "apikey":        SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      }
    );

    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Supabase error ${r.status}: ${err}`);
    }

    const messages = await r.json();
    return res.status(200).json({ phone: rawPhone, messages });

  } catch (err: any) {
    console.error("[WhatsApp History] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
