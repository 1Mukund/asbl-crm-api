/**
 * Operational collections — tiny helpers around three append-mostly Mongo
 * collections that replace their Supabase counterparts in Phase 8 of the
 * migration:
 *
 *   whatsapp_sender_map — { _id: phone, sender, updated_at }
 *     Phone → ASBL sender number mapping. Used so returning customers
 *     always reach the same RM number on follow-ups.
 *
 *   follow_up_log — { phone, follow_up_day, sender, created_at }
 *     Append-only audit of which follow-up day has been sent to which
 *     phone. The cron uses it to decide what day-N message to send next.
 *
 *   cron_log — { task, ran_at, duration_ms, result, error }
 *     Cron run audit. Dashboard reads recent runs.
 *
 * Plus a round-robin sender-index counter (replaces the Postgres
 * get_next_sender_index RPC) via the _counters collection.
 */

import { getCollection, getNextSequence, COL } from "./mongo";

// ─── whatsapp_sender_map ──────────────────────────────────────────────────

interface SenderMapDoc {
  _id: string;          // phone (digits)
  phone: string;
  sender: string;       // org_phone of the ASBL sender number
  updated_at: string;
}

function cleanPhone(p: string): string {
  return String(p || "").replace(/\D/g, "");
}

export async function getSenderForPhone(phone: string): Promise<string | null> {
  const clean = cleanPhone(phone);
  if (!clean) return null;
  try {
    const col = await getCollection<SenderMapDoc>(COL.WHATSAPP_SENDER_MAP);
    const doc = await col.findOne({ _id: clean as any });
    return doc?.sender || null;
  } catch (err: any) {
    console.error(`[ops] getSenderForPhone failed: ${err.message}`);
    return null;
  }
}

export async function setSenderForPhone(phone: string, sender: string): Promise<void> {
  const clean = cleanPhone(phone);
  if (!clean || !sender) return;
  try {
    const col = await getCollection<SenderMapDoc>(COL.WHATSAPP_SENDER_MAP);
    await col.updateOne(
      { _id: clean as any },
      {
        $set: { sender, updated_at: new Date().toISOString() },
        $setOnInsert: { _id: clean, phone: clean } as any,
      },
      { upsert: true },
    );
  } catch (err: any) {
    console.error(`[ops] setSenderForPhone failed: ${err.message}`);
  }
}

// ─── Round-robin sender index (replaces Postgres get_next_sender_index) ───

/** Atomic monotonic counter, modded by numSenders to pick the next index. */
export async function getNextSenderIndex(numSenders: number): Promise<number> {
  if (!numSenders || numSenders < 1) return 0;
  try {
    const n = await getNextSequence("sender_idx", 0);
    return n % numSenders;
  } catch (err: any) {
    console.error(`[ops] getNextSenderIndex failed: ${err.message}`);
    return Math.floor(Math.random() * numSenders);
  }
}

// ─── follow_up_log ────────────────────────────────────────────────────────

export interface FollowUpLogRow {
  phone: string;
  follow_up_day: number;
  sender: string;
  created_at?: string;
}

/** Insert one follow-up audit row. */
export async function appendFollowUpLog(row: FollowUpLogRow): Promise<void> {
  try {
    const col = await getCollection(COL.FOLLOW_UP_LOG);
    await col.insertOne({
      phone: cleanPhone(row.phone),
      follow_up_day: row.follow_up_day,
      sender: row.sender,
      created_at: row.created_at || new Date().toISOString(),
    } as any);
  } catch (err: any) {
    console.error(`[ops] appendFollowUpLog failed: ${err.message}`);
  }
}

/** All follow-up rows for the cron's "what day is everyone on" computation. */
export async function getAllFollowUpLog(limit: number = 5000): Promise<FollowUpLogRow[]> {
  try {
    const col = await getCollection(COL.FOLLOW_UP_LOG);
    const rows = await col.find({}).limit(limit).toArray();
    return rows.map((r: any) => ({
      phone: String(r.phone || ""),
      follow_up_day: Number(r.follow_up_day || 0),
      sender: String(r.sender || ""),
      created_at: r.created_at,
    }));
  } catch (err: any) {
    console.error(`[ops] getAllFollowUpLog failed: ${err.message}`);
    return [];
  }
}

// ─── cron_log ─────────────────────────────────────────────────────────────

export interface CronLogRow {
  task: string;
  ran_at?: string;
  duration_ms: number;
  result: any;
  error: string | null;
}

export async function appendCronLog(row: CronLogRow): Promise<void> {
  try {
    const col = await getCollection(COL.CRON_LOG);
    await col.insertOne({
      task: row.task,
      ran_at: row.ran_at || new Date().toISOString(),
      duration_ms: row.duration_ms,
      result: row.result,
      error: row.error,
    } as any);
  } catch (err: any) {
    console.error(`[ops] appendCronLog failed: ${err.message}`);
  }
}

/** Dashboard "recent cron runs" widget — newest first. */
export async function getRecentCronRuns(limit: number = 20): Promise<any[]> {
  try {
    const col = await getCollection(COL.CRON_LOG);
    return await col.find({}).sort({ ran_at: -1 }).limit(limit).toArray();
  } catch (err: any) {
    console.error(`[ops] getRecentCronRuns failed: ${err.message}`);
    return [];
  }
}
