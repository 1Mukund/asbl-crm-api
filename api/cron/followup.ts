/**
 * GET /api/cron/followup
 * Vercel Cron — runs daily at 04:30 UTC (10:00 AM IST)
 *
 * Logic:
 *   1. Get all phones we contacted (outbound messages in whatsapp_messages)
 *   2. Filter: no inbound reply ever received
 *   3. For each, check how many follow-ups already sent (follow_up_log)
 *   4. If < 10 and enough days have passed → send next follow-up
 *   5. Log to follow_up_log
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

const SUPABASE_URL       = process.env.SUPABASE_URL || "";
const SUPABASE_KEY       = process.env.SUPABASE_SECRET_KEY || "";
const PERISKOPE_API_KEY  = process.env.PERISKOPE_API_KEY || "";
const PERISKOPE_API_URL  = "https://api.periskope.app/v1/messages/send";

// ── 10 follow-up messages — professional English, no emojis ─────────────────
// From Anandita Reddy, Relationship Manager at ASBL
const FOLLOWUP_MESSAGES: string[] = [
  // Day 1
  `Dear Customer,

This is Anandita Reddy from ASBL. I wanted to follow up on your recent enquiry regarding ASBL Loft. We currently have a limited-time offer available that I believe would be of interest to you.

Please reply to this message at your convenience and I will be happy to share the details.`,

  // Day 2
  `Dear Customer,

I am reaching out again regarding your interest in ASBL Loft. The current pricing is very competitive and we have been receiving a strong response from prospective buyers.

I would be glad to walk you through the options available. Please feel free to reply and we can take it from there.`,

  // Day 3
  `Dear Customer,

I wanted to bring to your attention that the west-facing 1695 sq ft units at ASBL Loft are in high demand. Availability for this particular configuration is limited.

If you would like me to reserve a unit for your consideration, please reply and I will arrange it right away.`,

  // Day 4
  `Dear Customer,

Just a quick follow-up to let you know that the current offer at ASBL Loft is available for a limited period. Both the pricing and payment terms are very favorable at this time.

Should you have any questions, please do not hesitate to reply or call me directly.`,

  // Day 5
  `Dear Customer,

I am writing to inform you that only a few west-facing 1695 sq ft units remain available at ASBL Loft. This size and orientation has been among the most sought-after in the project.

I would recommend an early decision to secure the unit of your choice. Please reply and I will assist you promptly.`,

  // Day 6
  `Dear Customer,

The special pricing currently available at ASBL Loft is applicable for a limited number of bookings. Once these are utilised, the pricing will revert to standard rates.

If you are considering a purchase, now would be a good time to connect. Please reply at your convenience.`,

  // Day 7
  `Dear Customer,

We have seen considerable booking activity at ASBL Loft over the past few days. While floor plan and unit selection is still available, choices may become limited soon.

Please reply if you would like to discuss further. I am happy to answer any questions you may have.`,

  // Day 8
  `Dear Customer,

I wanted to remind you that the current offer at ASBL Loft is nearing its close. Securing the same terms at a later date may not be possible.

If now is a good time to connect, please reply and we can schedule a call or a site visit as per your preference.`,

  // Day 9
  `Dear Customer,

The west-facing 1695 sq ft configuration at ASBL Loft continues to receive strong interest. If you are evaluating this option, I am happy to provide all the details clearly and without any pressure.

Please reply whenever you are ready and I will ensure you have everything you need to make an informed decision.`,

  // Day 10
  `Dear Customer,

This will be my final follow-up message. I completely understand if the timing is not right at the moment.

Should you ever wish to revisit ASBL Loft or have any questions in the future, please feel free to reach out. The offer remains open and I am always available to assist you.`,
];

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function supabaseGet(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return r.json();
}

async function supabasePost(table: string, body: object): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      apikey:          SUPABASE_KEY,
      Authorization:   `Bearer ${SUPABASE_KEY}`,
      Prefer:          "resolution=ignore-duplicates", // skip if already sent
    },
    body: JSON.stringify(body),
  });
}

// ── Get sender for phone from whatsapp_sender_map ─────────────────────────────
async function getSender(phone: string): Promise<string | null> {
  const rows = await supabaseGet(
    `whatsapp_sender_map?phone=eq.${phone}&limit=1`
  );
  return rows?.[0]?.sender || null;
}

// ── Send via Periskope ────────────────────────────────────────────────────────
async function sendMessage(phone: string, sender: string, message: string): Promise<void> {
  // Typing indicator
  try {
    await fetch("https://api.periskope.app/v1/chats/typing", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:   `Bearer ${PERISKOPE_API_KEY}`,
        "x-phone":       sender,
      },
      body: JSON.stringify({ chat_id: `${phone}@c.us` }),
    });
  } catch { /* not critical */ }

  await new Promise(r => setTimeout(r, 3000)); // 3s delay

  const r = await fetch(PERISKOPE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      Authorization:   `Bearer ${PERISKOPE_API_KEY}`,
      "x-phone":       sender,
    },
    body: JSON.stringify({ chat_id: phone, message }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Periskope error ${r.status}: ${t}`);
  }
}

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Security: only allow Vercel cron or internal calls
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && req.method !== "GET") {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    // 1. Get all unique phones that got outbound messages
    const outbound = await supabaseGet(
      `whatsapp_messages?direction=eq.outbound&order=created_at.asc&limit=2000`
    );

    // earliest outbound per phone
    const firstOutbound = new Map<string, number>(); // phone → timestamp
    for (const row of outbound) {
      if (!firstOutbound.has(row.phone)) {
        firstOutbound.set(row.phone, new Date(row.created_at).getTime());
      }
    }

    // 2. Get all phones that have replied (inbound)
    const inbound = await supabaseGet(
      `whatsapp_messages?direction=eq.inbound&limit=2000`
    );
    const repliedPhones = new Set(inbound.map((r: any) => r.phone));

    // 3. Get follow-up log
    const followupLog = await supabaseGet(`follow_up_log?limit=2000`);
    const followupCount = new Map<string, number>(); // phone → max day sent
    for (const row of followupLog) {
      const current = followupCount.get(row.phone) || 0;
      if (row.follow_up_day > current) followupCount.set(row.phone, row.follow_up_day);
    }

    const results: string[] = [];

    // 4. Process each phone
    for (const [phone, firstSentMs] of firstOutbound) {
      // Skip if they've replied
      if (repliedPhones.has(phone)) continue;

      const daysSinceFirst = Math.floor((now - firstSentMs) / ONE_DAY_MS);
      const lastFollowupDay = followupCount.get(phone) || 0;
      const nextFollowupDay = lastFollowupDay + 1;

      // Only send if: enough days passed AND still within 10 days
      if (nextFollowupDay > 10) continue;
      if (daysSinceFirst < nextFollowupDay) continue;

      // Get sender
      const sender = await getSender(phone);
      if (!sender) {
        console.log(`[Followup] No sender found for ${phone}, skipping`);
        continue;
      }

      // Get message
      const message = FOLLOWUP_MESSAGES[nextFollowupDay - 1];

      try {
        await sendMessage(phone, sender, message);

        // Log to Supabase
        await supabasePost("follow_up_log", {
          phone,
          follow_up_day: nextFollowupDay,
          sender,
        });

        // Save to whatsapp_messages
        await supabasePost("whatsapp_messages", {
          phone,
          direction: "outbound",
          message,
          sender,
        });

        console.log(`[Followup] ✅ ${phone} → Day ${nextFollowupDay}`);
        results.push(`${phone}: Day ${nextFollowupDay} sent`);

        // Delay between messages to avoid rate limits
        await new Promise(r => setTimeout(r, 2000));

      } catch (err: any) {
        console.error(`[Followup] ❌ ${phone}: ${err.message}`);
        results.push(`${phone}: ERROR - ${err.message}`);
      }
    }

    return res.status(200).json({
      success: true,
      processed: results.length,
      results,
    });

  } catch (err: any) {
    console.error("[Followup Cron] Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
