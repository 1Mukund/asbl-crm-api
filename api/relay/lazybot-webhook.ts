/**
 * LazyBot → Zoho webhook handler
 * LazyBot fires this when customer sends a WhatsApp message (message.received)
 * Updates Zoho: Whatsapp_Replied = true, Last_Whatsapp_At, Whatsapp_Sent = true
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { findLeadByPhone, updateLead, getAccessToken } from "../_utils/zoho";
import axios from "axios";

const ZOHO_API_BASE = "https://www.zohoapis.in/crm/v3";

// Extract clean phone from LazyBot waId (919876543210@s.whatsapp.net or lid@lid)
function extractPhone(waId: string): string | null {
  if (!waId) return null;
  // Remove @s.whatsapp.net or @lid suffix
  const raw = waId.split("@")[0];
  // Remove device id if present (e.g. 91987654:12 → 91987654)
  const phone = raw.split(":")[0].replace(/\D/g, "");
  if (phone.length < 10) return null;
  return phone;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-LazyBot-Event, X-LazyBot-Signature");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    const event = body?.event || req.headers["x-lazybot-event"];

    console.log(`[LazyBot Webhook] Event: ${event}`);

    // Only handle inbound customer messages
    if (event !== "message.received") {
      return res.status(200).json({ skipped: true, event });
    }

    const data = body?.data;
    const waId: string = data?.chat?.waId || "";
    const messageBody: string = data?.message?.body || "";

    const phone = extractPhone(waId);
    if (!phone) {
      console.log(`[LazyBot Webhook] Could not extract phone from waId: ${waId}`);
      return res.status(200).json({ skipped: true, reason: "no phone" });
    }

    console.log(`[LazyBot Webhook] Customer replied — phone: ${phone}, message: ${messageBody}`);

    // Find lead in Zoho by phone
    const lead = await findLeadByPhone(phone);
    if (!lead) {
      console.log(`[LazyBot Webhook] No Zoho lead found for phone: ${phone}`);
      return res.status(200).json({ skipped: true, reason: "lead not found", phone });
    }

    // Update Zoho lead
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
    await updateLead(lead.id, {
      Whatsapp_Replied: true,
      Whatsapp_Sent: true,
      Last_Whatsapp_At: now,
    });

    console.log(`[LazyBot Webhook] Zoho updated for lead ${lead.id} (phone: ${phone})`);
    return res.status(200).json({ success: true, lead_id: lead.id, phone });

  } catch (err: any) {
    console.error("[LazyBot Webhook] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
