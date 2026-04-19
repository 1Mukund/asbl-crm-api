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

// ── 10 follow-up messages — FOMO-based, no specific prices or market data ────
// From Anandita — short, conversational, Hindi/English mix
const FOLLOWUP_MESSAGES: string[] = [
  // Day 1
  `Hi! Main Aanandita hoon, ASBL se. 😊

Bas ek quick update dena chahti thi — abhi ASBL Loft pe ek *exciting offer chal raha hai*. Details share karungi jab baat ho, lekin yeh offer limited time ke liye hai.

Interested hain to ek baar reply zaroor karein! 🏠`,

  // Day 2
  `Namaste! Aanandita yahan. 🙏

Suna hai aap ASBL Loft mein interested hain — aaj batana chahti thi ki abhi jo *pricing chal rahi hai*, woh bahut acha deal hai. Bohot log is price point pe booking kar rahe hain.

Ek baar baat karte hain? Reply karein! 😊`,

  // Day 3
  `Hi! Aanandita here.

ASBL Loft mein *1695 sq ft west facing units* abhi bahut tezi se bik rahi hain. Yeh size aur facing combination limited hai — jo jaldi decide karta hai usko milta hai.

Aapke liye hold karwa sakti hoon — batao! 🏠`,

  // Day 4
  `Namaste! Aanandita here. 😊

Just checking in — ASBL Loft pe *current offer* aur kuch din hi hai. Price aur terms dono bahut favorable hain abhi.

Koi bhi sawaal ho — call karein ya reply karein, main hoon yahan!`,

  // Day 5
  `Hi! Main Aanandita — ASBL se.

Aaj specially isliye message kar rahi hoon ki *west facing 1695 sq ft* mein se kuch units hi bacha hain. Is size ki demand bahut zyada hai Loft mein.

Agar serious hain to abhi baat karte hain — warna yeh units nahi milenge. 🙏`,

  // Day 6
  `Namaste! Aanandita yahan.

ASBL Loft mein jo *special pricing* chal rahi hai — woh sirf kuch bookings ke liye aur available hai. Uske baad normal price pe jaayega.

Ek baar milte hain ya call karte hain? Reply karein! 😊`,

  // Day 7
  `Hi! Aanandita here. 🏠

Last few days mein *kaafi bookings* ho gayi hain ASBL Loft mein. Floor plan aur unit selection abhi bhi hai, lekin jaldi decision lena theek rahega.

Koi doubt ya sawaal ho — seedha reply karein, main personally handle karungi!`,

  // Day 8
  `Namaste! Aanandita here.

Bas ek baar aur remind karna chahti thi — ASBL Loft ka *current offer* close hone wala hai. Iske baad same deal milna mushkil hoga.

Abhi baat karein? 🙏`,

  // Day 9
  `Hi! Aanandita yahan — ASBL se. 😊

*1695 west facing* — yeh unit specifically bahut popular hai. Agar aap consider kar rahe hain to please ek baar baat karte hain, main poori detail clearly explain karungi bina kisi pressure ke.

Reply ka wait karungi! 🏠`,

  // Day 10
  `Namaste! Main Aanandita — ASBL.

Yeh mera aakhri follow-up hai. Koi pressure nahi — bas itna kehna tha ki agar kabhi bhi ASBL Loft ke baare mein baat karni ho, main available hoon.

*Offer abhi bhi chal raha hai* — jab ready ho, reply karein. Hoon yahan! 🙏`,
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
