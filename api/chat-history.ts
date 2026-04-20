import type { VercelRequest, VercelResponse } from "@vercel/node";

const LAZYBOT_URL = process.env.LAZYBOT_URL || "https://lazybot-whatsapp-crm.onrender.com";
const LAZYBOT_API_KEY = process.env.LAZYBOT_API_KEY || "";
const LAZYBOT_SESSION_ID = process.env.LAZYBOT_SESSION_ID || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow iframe embedding from Zoho
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    const phone = req.query.phone as string;
    if (!phone) return res.status(400).json({ error: "phone required" });

    // source=supabase → fetch from Supabase whatsapp_messages table
    if (req.query.source === "supabase") {
      const rawPhone = phone.replace(/\D/g, "");
      if (rawPhone.length < 10) return res.status(400).json({ error: "invalid phone" });
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/whatsapp_messages?phone=eq.${rawPhone}&order=created_at.asc&limit=200`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        if (!r.ok) throw new Error(`Supabase error ${r.status}: ${await r.text()}`);
        const messages = await r.json();
        return res.status(200).json({ phone: rawPhone, messages });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Default → fetch from Lazybot
    try {
      const url = `${LAZYBOT_URL}/api/v1/messages/by-phone?phone=${phone}&sessionId=${LAZYBOT_SESSION_ID}&limit=100`;
      const r = await fetch(url, { headers: { "X-API-Key": LAZYBOT_API_KEY } });
      const data = await r.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    // Send a message via Lazybot
    const { phone, message } = req.body as { phone: string; message: string };
    if (!phone || !message) return res.status(400).json({ error: "phone and message required" });

    try {
      const r = await fetch(`${LAZYBOT_URL}/api/v1/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": LAZYBOT_API_KEY },
        body: JSON.stringify({ sessionId: LAZYBOT_SESSION_ID, phone, message }),
      });
      const data = await r.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
