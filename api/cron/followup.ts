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

// ── 10 follow-up messages — Hyderabad real estate market facts ──────────────
// All from Anandita, conversational Hindi/English mix, no fabricated prices
const FOLLOWUP_MESSAGES: string[] = [
  // Day 1
  `Hi! Main Aanandita hoon, ASBL se. 😊

Sirf ek market update share karna chahti thi — Hyderabad abhi India ka *sabse bada GCC hub* ban gaya hai. Microsoft, Google, Amazon, Meta — 200+ global companies ne yahan apne Global Capability Centres khole hain.

Iska seedha impact residential demand pe padta hai — in offices ke aaspaas achhe homes ki zaroorat badh rahi hai.

Koi sawaal ho to reply karein, main hoon yahan! 🏠`,

  // Day 2
  `Namaste! Aanandita yahan. 🙏

Aaj TDR ke baare mein batana chahti thi — *Transfer of Development Rights* Telangana mein ek powerful policy hai jo builders ko city ke certain zones mein zyada floor space deta hai. Iska matlab — premium locations mein limited supply rehti hai, aur jo projects ban bhi rahe hain woh zyada carefully planned hote hain.

ASBL ke projects isi planning ke saath bane hain.

Koi cheez poochni ho? 😊`,

  // Day 3
  `Hi! Aanandita here.

Ek interesting fact — Hyderabad ka *Outer Ring Road (ORR)* corridor India ke fastest-growing real estate micro-markets mein se ek hai. Kokapet, Narsingi, Financial District — yeh sab ORR ke saath connected hain.

Connectivity jo pehle issue thi, ab woh strength ban gayi hai is area ki.

ASBL ke projects isi corridor pe hain. Kuch aur jaanna ho to batao! 🏙️`,

  // Day 4
  `Namaste! Aanandita here. 😊

Kya aap jaante hain — Hyderabad India ke *top rental yield cities* mein consistently aata hai? HITEC City aur Financial District ke aaspaas rental demand IT professionals ki wajah se har saal strong rehti hai.

Jo log investment ke liye soch rahe hain — rental income ek steady return deta hai yahan.

Koi query ho to zaroor reply karein!`,

  // Day 5
  `Hi! Main Aanandita — ASBL.

Aaj Hyderabad ke *Pharma City* ke baare mein — yeh Asia ka sabse bada pharma cluster banne ki raah pe hai. 15,000+ acres ka project, lakhs jobs create karega. Yeh poora corridor — Shamshabad se Mucherla tak — infrastructure ke mamle mein rapidly develop ho raha hai.

Real estate mein long-term value employment hubs ke aaspaas banti hai. Yeh ek aisi location hai.

Koi sawaal? Main hoon yahan! 🙂`,

  // Day 6
  `Namaste! Aanandita here.

Ek aur interesting development — Hyderabad mein *Metro Phase 2* ka expansion plan approved hai. New corridors connect karenge HITEC City ko aur bhi areas se. Infrastructure investment ka real estate pe direct positive impact padta hai — yeh globally proven hai.

ASBL ke projects in well-connected locations mein hain.

Reply karein — main personally help karunga/karoongi! 🚇`,

  // Day 7
  `Hi! Aanandita yahan. 😊

EY, Deloitte, JP Morgan, HSBC — India ke bade financial aur consulting firms ne Hyderabad mein apne operations *significantly expand* kiye hain last few years mein. Yeh sirf IT nahi — diversification ho rahi hai economy ki.

Iska matlab job creation aur housing demand dono sustained rahenge.

Koi bhi cheez poochni ho ASBL projects ke baare mein — reply karein! 🏠`,

  // Day 8
  `Namaste! Aanandita here.

Aaj *NRI investment* ke baare mein — Hyderabad consistently top NRI real estate investment destinations mein aata hai. Stable governance, world-class infrastructure, aur cosmopolitan culture — yeh factors globally Indians ko attract karte hain.

Iska matlab — is market mein strong external demand bhi hai, sirf local nahi.

Koi sawaal ho to batao! 🌍`,

  // Day 9
  `Hi! Aanandita yahan — ASBL se.

Telangana government ki *IT export policy* aur ease of doing business ranking consistently improve ho rahi hai. State mein investment aata hai to jobs aate hain, jobs aate hain to housing demand badhti hai — yeh simple equation hai.

Hyderabad is cycle mein ek stable, growing market hai.

Main chahti hoon ki aap informed decision lein — koi bhi cheez poochni ho, reply karein! 😊`,

  // Day 10
  `Namaste! Main Aanandita — ASBL.

Yeh mera aakhri follow-up hai. Main sirf itna kehna chahti thi — main genuinely help karna chahti hoon, koi pressure nahi.

Agar abhi ready nahi hain — bilkul theek hai. Agar koi doubt hai, ya sirf samajhna chahte hain ki ASBL kya offer karta hai aur Hyderabad market ke baare mein — ek baar reply karein, 5 minutes ki baat hai.

Hoon yahan jab bhi zaroorat ho! 🙏🏠`,
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
