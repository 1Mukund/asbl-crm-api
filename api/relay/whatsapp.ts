/**
 * Zoho → LazyBot WhatsApp relay
 * Zoho Deluge calls this endpoint to send WhatsApp messages via LazyBot
 *
 * POST /api/relay/whatsapp
 * Body: { phone: "919876543210", message: "Hi..." }
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const LAZYBOT_URL = process.env.LAZYBOT_URL || "https://lazybot-whatsapp-crm.onrender.com";
const LAZYBOT_API_KEY = process.env.LAZYBOT_API_KEY || "";
const LAZYBOT_SESSION_ID = process.env.LAZYBOT_SESSION_ID || "";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { phone, message, first_name, project } = req.body || {};

    if (!phone) return res.status(400).json({ error: "phone required" });

    // Use provided message or build default template
    const text = message || buildTemplate(first_name, project);

    console.log(`[WhatsApp Relay] Sending to ${phone}: ${text.slice(0, 80)}...`);

    const r = await fetch(`${LAZYBOT_URL}/api/v1/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": LAZYBOT_API_KEY,
      },
      body: JSON.stringify({
        sessionId: LAZYBOT_SESSION_ID,
        phone,
        message: text,
      }),
    });

    const data = await r.json() as any;

    if (!r.ok) {
      console.error("[WhatsApp Relay] LazyBot error:", data);
      return res.status(502).json({ error: "LazyBot send failed", detail: data });
    }

    console.log(`[WhatsApp Relay] Sent successfully to ${phone}`);
    return res.status(200).json({ success: true, phone, ...data });

  } catch (err: any) {
    console.error("[WhatsApp Relay] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

function buildTemplate(firstName?: string, project?: string): string {
  const name = firstName && firstName.trim() ? firstName.trim() : "there";
  const proj = project && project.trim() ? project.trim() : "your selected property";
  return `Hi ${name}! 👋\n\nWe tried calling you regarding *${proj}* but couldn't reach you.\n\nFeel free to reply here and our team will get back to you shortly! 🏠`;
}
