/**
 * Conversation context — fetches last 30 days of WhatsApp messages
 * for a phone number from Supabase whatsapp_messages table.
 * Returns formatted string for system prompt injection.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

const HISTORY_DAYS = 30;
const MAX_MESSAGES = 80; // safety cap on context size

export interface ConversationSummary {
  formatted: string;
  totalMessages: number;
  daysSinceLast: number | null; // null if no prior messages
  lastProject: string | null;   // project of most recent message
}

export async function getConversationContext(phone: string): Promise<ConversationSummary> {
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_messages` +
        `?phone=eq.${phone}` +
        `&created_at=gte.${cutoff}` +
        `&order=created_at.asc` +
        `&limit=${MAX_MESSAGES}` +
        `&select=direction,message,project,created_at`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );

    const rows = (await r.json()) as Array<{
      direction: "inbound" | "outbound";
      message: string;
      project: string | null;
      created_at: string;
    }>;

    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        formatted: "no prior conversation",
        totalMessages: 0,
        daysSinceLast: null,
        lastProject: null,
      };
    }

    // Format chronologically
    const lines = rows.map((row) => {
      const dt = new Date(row.created_at);
      const date = dt.toISOString().slice(0, 10);
      const time = dt.toISOString().slice(11, 16);
      const role = row.direction === "inbound" ? "customer" : "you";
      // Truncate very long messages to keep context budget reasonable
      const msg = row.message.length > 400 ? row.message.slice(0, 400) + "..." : row.message;
      return `[${date} ${time}] ${role}: ${msg}`;
    });

    const last = rows[rows.length - 1];
    const lastTimeMs = new Date(last.created_at).getTime();
    const daysSinceLast = Math.floor((Date.now() - lastTimeMs) / (24 * 60 * 60 * 1000));

    // Find most recent project (walk from end)
    let lastProject: string | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].project) {
        lastProject = rows[i].project;
        break;
      }
    }

    return {
      formatted: lines.join("\n"),
      totalMessages: rows.length,
      daysSinceLast,
      lastProject,
    };
  } catch (err: any) {
    console.error(`[ConversationContext] fetch failed: ${err.message}`);
    return {
      formatted: "no prior conversation (fetch error)",
      totalMessages: 0,
      daysSinceLast: null,
      lastProject: null,
    };
  }
}
