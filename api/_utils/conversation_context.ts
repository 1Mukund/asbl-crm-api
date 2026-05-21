/**
 * Conversation context — fetches last 30 days of WhatsApp messages
 * for a phone number from Mongo whatsapp_messages collection.
 * Returns formatted string for system prompt injection.
 *
 * MIGRATED FROM SUPABASE → MongoDB (Phase 4). Behaviour identical to
 * the original Supabase implementation: ASC order, 80-msg cap, same
 * truncation rules, same "no prior conversation" fallback string.
 */

import { getMessagesForPhone } from "./whatsapp_messages";

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
    const rows = await getMessagesForPhone(phone, { sinceISO: cutoff, limit: MAX_MESSAGES });

    if (!rows.length) {
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
      const msg = (row.message || "").length > 400
        ? (row.message || "").slice(0, 400) + "..."
        : (row.message || "");
      return `[${date} ${time}] ${role}: ${msg}`;
    });

    const last = rows[rows.length - 1];
    const lastTimeMs = new Date(last.created_at).getTime();
    const daysSinceLast = Math.floor((Date.now() - lastTimeMs) / (24 * 60 * 60 * 1000));

    let lastProject: string | null = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].project) {
        lastProject = rows[i].project ?? null;
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
