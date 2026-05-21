/**
 * whatsapp_messages — central read/write helper for the bot's chat history.
 *
 * MIGRATED FROM SUPABASE → MongoDB (Phase 4 of the Mongo migration).
 * Collection: "whatsapp_messages" inside the "Zoho_Database" Mongo db.
 *
 * Document schema:
 *   {
 *     _id: ObjectId,
 *     phone: string,                          // digits only
 *     direction: "inbound" | "outbound",
 *     message: string,
 *     sender: string | null,                  // org_phone of the ASBL sender number
 *     project: string | null,                 // LOFT / SPECTRA / ... or null
 *     intent: string | null,                  // Zoho intent (price/brochure/...)
 *     created_at: string                      // ISO string (NOT Date — keeps
 *                                             // Supabase compat; sort works the
 *                                             // same since ISO is lex-sortable)
 *   }
 *
 * Indexes (created at module load on first call — see ensureIndexes):
 *   { phone: 1, created_at: -1 }              ← main bot history read
 *   { phone: 1, project: 1, created_at: -1 }  ← project_detection.ts
 *   { created_at: -1 }                        ← dashboard 24h activity
 *   { direction: 1, created_at: -1 }          ← cron follow-up scans
 */

import { getCollection, COL } from "./mongo";

export type Direction = "inbound" | "outbound";

export interface WhatsappMessage {
  phone: string;
  direction: Direction;
  message: string;
  sender?: string | null;
  project?: string | null;
  intent?: string | null;
  /** ISO timestamp string. */
  created_at: string;
}

// Index setup runs once per process (Vercel warm invocations reuse it).
let _indexesEnsured = false;
async function ensureIndexes(): Promise<void> {
  if (_indexesEnsured) return;
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    await Promise.all([
      col.createIndex({ phone: 1, created_at: -1 }, { name: "phone_time" }),
      col.createIndex(
        { phone: 1, project: 1, created_at: -1 },
        { name: "phone_project_time" },
      ),
      col.createIndex({ created_at: -1 }, { name: "time" }),
      col.createIndex(
        { direction: 1, created_at: -1 },
        { name: "direction_time" },
      ),
    ]);
    _indexesEnsured = true;
  } catch (err: any) {
    console.error(`[whatsapp_messages] ensureIndexes failed: ${err.message}`);
  }
}

function cleanPhone(p: string): string {
  return String(p || "").replace(/\D/g, "");
}

// ─── Writes ───────────────────────────────────────────────────────────────

/** Insert a single message. created_at is set to NOW unless caller provides
 *  one (e.g. when backfilling from Supabase rows with their original times). */
export async function insertMessage(msg: WhatsappMessage): Promise<void> {
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    await col.insertOne({
      phone: cleanPhone(msg.phone),
      direction: msg.direction,
      message: msg.message || "",
      sender: msg.sender ?? null,
      project: msg.project ?? null,
      intent: msg.intent ?? null,
      created_at: msg.created_at || new Date().toISOString(),
    } as any);
  } catch (err: any) {
    console.error(`[whatsapp_messages] insertMessage failed: ${err.message}`);
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────

/** Used by conversation_context.ts. Returns last N days for a phone,
 *  chronologically ASC (oldest first) — same order Supabase query did. */
export async function getMessagesForPhone(
  phone: string,
  opts: { sinceISO?: string; limit?: number } = {},
): Promise<WhatsappMessage[]> {
  const clean = cleanPhone(phone);
  if (!clean) return [];
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const filter: any = { phone: clean };
    if (opts.sinceISO) filter.created_at = { $gte: opts.sinceISO };
    const cursor = col
      .find(filter)
      .sort({ created_at: 1 })  // ASC for chronological replay
      .limit(opts.limit ?? 2000);
    return (await cursor.toArray()) as any;
  } catch (err: any) {
    console.error(`[whatsapp_messages] getMessagesForPhone failed: ${err.message}`);
    return [];
  }
}

/** Used by project_detection.ts — "last asked project" lookup. Returns the
 *  most-recent N messages where project is non-null, newest first. */
export async function getRecentProjectMessages(
  phone: string,
  limit: number = 5,
): Promise<Array<Pick<WhatsappMessage, "project" | "direction" | "created_at">>> {
  const clean = cleanPhone(phone);
  if (!clean) return [];
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const cursor = col
      .find({ phone: clean, project: { $ne: null } })
      .project({ project: 1, direction: 1, created_at: 1, _id: 0 })
      .sort({ created_at: -1 })
      .limit(limit);
    return (await cursor.toArray()) as any;
  } catch (err: any) {
    console.error(`[whatsapp_messages] getRecentProjectMessages failed: ${err.message}`);
    return [];
  }
}

/** Dashboard activity widget — last N msgs across all phones in the
 *  past 24 hours, newest first. */
export async function getRecentActivity(
  sinceISO: string,
  limit: number = 300,
): Promise<WhatsappMessage[]> {
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const cursor = col
      .find({ created_at: { $gte: sinceISO } })
      .project({
        phone: 1, direction: 1, message: 1, project: 1,
        intent: 1, sender: 1, created_at: 1, _id: 0,
      })
      .sort({ created_at: -1 })
      .limit(limit);
    return (await cursor.toArray()) as any;
  } catch (err: any) {
    console.error(`[whatsapp_messages] getRecentActivity failed: ${err.message}`);
    return [];
  }
}

/** Dashboard intent-distribution widget — inbound msgs in window with intent
 *  set, grouped via $group. Returns [{project, intent, count}]. */
export async function getInboundIntentStats(
  sinceISO: string,
): Promise<Array<{ project: string | null; intent: string; count: number }>> {
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const agg = await col
      .aggregate([
        {
          $match: {
            created_at: { $gte: sinceISO },
            direction: "inbound",
            intent: { $ne: null },
          },
        },
        {
          $group: {
            _id: { project: "$project", intent: "$intent" },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();
    return agg.map((r: any) => ({
      project: r._id.project,
      intent: r._id.intent,
      count: r.count,
    }));
  } catch (err: any) {
    console.error(`[whatsapp_messages] getInboundIntentStats failed: ${err.message}`);
    return [];
  }
}

/** Lead-context endpoint — last 5 messages with intent for a phone. */
export async function getLastMessagesWithIntent(
  phone: string,
  limit: number = 5,
): Promise<Array<Pick<WhatsappMessage, "message" | "intent" | "direction" | "created_at">>> {
  const clean = cleanPhone(phone);
  if (!clean) return [];
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const cursor = col
      .find({ phone: clean })
      .project({ message: 1, intent: 1, direction: 1, created_at: 1, _id: 0 })
      .sort({ created_at: -1 })
      .limit(limit);
    return (await cursor.toArray()) as any;
  } catch (err: any) {
    console.error(`[whatsapp_messages] getLastMessagesWithIntent failed: ${err.message}`);
    return [];
  }
}

/** Cron follow-up — pull ALL outbound or inbound msgs (bounded). Used
 *  to compute "who was contacted X days ago and hasn't replied". */
export async function getAllByDirection(
  direction: Direction,
  limit: number = 5000,
): Promise<WhatsappMessage[]> {
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const cursor = col
      .find({ direction })
      .sort({ created_at: 1 })
      .limit(limit);
    return (await cursor.toArray()) as any;
  } catch (err: any) {
    console.error(`[whatsapp_messages] getAllByDirection failed: ${err.message}`);
    return [];
  }
}
