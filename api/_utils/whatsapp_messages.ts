/**
 * whatsapp_messages — phone-grouped, date-bucketed chat history.
 *
 * Schema (per Mukund's spec 2026-05-21):
 *   One document PER phone number. Inside, messages are bucketed by IST
 *   date string, with inbound and outbound arrays separated so you can
 *   open Compass and see exactly what was exchanged on any given day.
 *
 *   {
 *     _id:                "919876543210",
 *     phone:              "919876543210",
 *     total_count:        47,
 *     inbound_count:      22,
 *     outbound_count:     25,
 *     first_message_at:   ISO string,
 *     last_message_at:    ISO string,
 *     by_date: {
 *       "2026-05-21": {
 *         inbound:  [{ msg, time, project, intent }, ...],
 *         outbound: [{ msg, time, project, intent, sender }, ...]
 *       },
 *       "2026-05-20": { inbound: [...], outbound: [...] }
 *     }
 *   }
 *
 * Why this shape:
 *   - Compass-readable — one row per customer, drill into dates to see chat
 *   - Atomic writes — single updateOne $push appends to the right date+direction
 *   - 16 MB doc limit is generous (even 1000 messages × 1 KB each = 1 MB)
 *
 * Public API unchanged from Phase 4 v1 — call sites still consume FLAT
 * arrays of messages (we unwind the nested structure inside each reader).
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

// ─── Helpers ──────────────────────────────────────────────────────────────

function cleanPhone(p: string): string {
  return String(p || "").replace(/\D/g, "");
}

/** Convert an ISO timestamp to an IST-zone YYYY-MM-DD string. We don't
 *  depend on Intl.DateTimeFormat because Vercel's Node runtime sometimes
 *  ships without the full ICU data. Manual offset is reliable. */
function istDateKey(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  const shifted = new Date(d.getTime() + 330 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface DateBucket {
  inbound: any[];
  outbound: any[];
}

interface PhoneDoc {
  _id: string;
  phone: string;
  total_count: number;
  inbound_count: number;
  outbound_count: number;
  first_message_at: string;
  last_message_at: string;
  by_date: Record<string, DateBucket>;
}

let _indexesEnsured = false;
async function ensureIndexes(): Promise<void> {
  if (_indexesEnsured) return;
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    await col.createIndex({ last_message_at: -1 }, { name: "last_msg_time" });
    _indexesEnsured = true;
  } catch (err: any) {
    console.error(`[whatsapp_messages] ensureIndexes failed: ${err.message}`);
  }
}

// ─── Write ────────────────────────────────────────────────────────────────

/** Insert a single message. Upserts the phone document and $push'es the
 *  message into by_date[<IST date>][<direction>]. Counters and
 *  first/last timestamps are maintained atomically in the same op. */
export async function insertMessage(msg: WhatsappMessage): Promise<void> {
  await ensureIndexes();
  const phone = cleanPhone(msg.phone);
  if (!phone) return;
  const createdAt = msg.created_at || new Date().toISOString();
  const dateKey = istDateKey(createdAt);
  const direction = msg.direction;

  const item: any = {
    msg: msg.message || "",
    time: createdAt,
    project: msg.project ?? null,
    intent: msg.intent ?? null,
  };
  if (msg.sender) item.sender = msg.sender;

  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    await col.updateOne(
      { _id: phone as any },
      {
        $setOnInsert: {
          _id: phone,
          phone,
          first_message_at: createdAt,
        },
        $set: { last_message_at: createdAt },
        $inc: {
          total_count: 1,
          [`${direction}_count`]: 1,
        },
        $push: {
          [`by_date.${dateKey}.${direction}`]: item,
        } as any,
      },
      { upsert: true },
    );
  } catch (err: any) {
    console.error(`[whatsapp_messages] insertMessage failed: ${err.message}`);
  }
}

// ─── Internal: flatten a phone doc into a chronological array ─────────────

function flattenDoc(
  doc: Partial<PhoneDoc> | null,
  opts: { sinceISO?: string; direction?: Direction; onlyWithProject?: boolean } = {},
): Array<WhatsappMessage> {
  if (!doc || !doc.by_date) return [];
  const since = opts.sinceISO ? new Date(opts.sinceISO).getTime() : 0;
  const out: Array<WhatsappMessage> = [];
  for (const dateKey of Object.keys(doc.by_date)) {
    const bucket = doc.by_date[dateKey];
    if (!bucket) continue;
    const dirs: Direction[] = opts.direction ? [opts.direction] : ["inbound", "outbound"];
    for (const d of dirs) {
      const arr = (bucket as any)[d] || [];
      for (const m of arr) {
        const t = new Date(m.time).getTime();
        if (since && t < since) continue;
        if (opts.onlyWithProject && !m.project) continue;
        out.push({
          phone: doc.phone || "",
          direction: d,
          message: m.msg ?? "",
          sender: m.sender ?? null,
          project: m.project ?? null,
          intent: m.intent ?? null,
          created_at: m.time,
        });
      }
    }
  }
  // ASC by time
  out.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return out;
}

// ─── Reads ────────────────────────────────────────────────────────────────

/** Last N days for a phone, chronologically ASC (oldest first). */
export async function getMessagesForPhone(
  phone: string,
  opts: { sinceISO?: string; limit?: number } = {},
): Promise<WhatsappMessage[]> {
  const clean = cleanPhone(phone);
  if (!clean) return [];
  await ensureIndexes();
  try {
    const col = await getCollection<PhoneDoc>(COL.WHATSAPP_MESSAGES);
    const doc = await col.findOne({ _id: clean as any });
    const flat = flattenDoc(doc as any, { sinceISO: opts.sinceISO });
    return opts.limit && flat.length > opts.limit
      ? flat.slice(-opts.limit)  // most-recent N (since order is ASC)
      : flat;
  } catch (err: any) {
    console.error(`[whatsapp_messages] getMessagesForPhone failed: ${err.message}`);
    return [];
  }
}

/** Last N messages for a phone where project is set, DESC (newest first). */
export async function getRecentProjectMessages(
  phone: string,
  limit: number = 5,
): Promise<Array<Pick<WhatsappMessage, "project" | "direction" | "created_at">>> {
  const clean = cleanPhone(phone);
  if (!clean) return [];
  await ensureIndexes();
  try {
    const col = await getCollection<PhoneDoc>(COL.WHATSAPP_MESSAGES);
    const doc = await col.findOne({ _id: clean as any });
    const flat = flattenDoc(doc as any, { onlyWithProject: true });
    flat.reverse(); // newest first
    return flat.slice(0, limit).map((m) => ({
      project: m.project,
      direction: m.direction,
      created_at: m.created_at,
    }));
  } catch (err: any) {
    console.error(`[whatsapp_messages] getRecentProjectMessages failed: ${err.message}`);
    return [];
  }
}

/** Dashboard activity widget — all messages across all phones in the past
 *  N hours (sinceISO), newest first. */
export async function getRecentActivity(
  sinceISO: string,
  limit: number = 300,
): Promise<WhatsappMessage[]> {
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    // Only scan phone docs that had ANY activity since sinceISO
    const docs = await col
      .find({ last_message_at: { $gte: sinceISO } } as any)
      .sort({ last_message_at: -1 })
      .toArray();
    const all: WhatsappMessage[] = [];
    for (const d of docs as any[]) {
      const flat = flattenDoc(d, { sinceISO });
      for (const m of flat) all.push(m);
    }
    all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return all.slice(0, limit);
  } catch (err: any) {
    console.error(`[whatsapp_messages] getRecentActivity failed: ${err.message}`);
    return [];
  }
}

/** Dashboard intent-distribution widget — counts of (project, intent) for
 *  inbound msgs in the window. */
export async function getInboundIntentStats(
  sinceISO: string,
): Promise<Array<{ project: string | null; intent: string; count: number }>> {
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const docs = await col
      .find({ last_message_at: { $gte: sinceISO } } as any)
      .toArray();
    const counts = new Map<string, { project: string | null; intent: string; count: number }>();
    for (const d of docs as any[]) {
      const flat = flattenDoc(d, { sinceISO, direction: "inbound" });
      for (const m of flat) {
        if (!m.intent) continue;
        const key = `${m.project || ""}|${m.intent}`;
        const cur = counts.get(key);
        if (cur) cur.count++;
        else counts.set(key, { project: m.project, intent: m.intent, count: 1 });
      }
    }
    return Array.from(counts.values());
  } catch (err: any) {
    console.error(`[whatsapp_messages] getInboundIntentStats failed: ${err.message}`);
    return [];
  }
}

/** Lead-context endpoint — last N messages with intent for a phone, DESC. */
export async function getLastMessagesWithIntent(
  phone: string,
  limit: number = 5,
): Promise<Array<Pick<WhatsappMessage, "message" | "intent" | "direction" | "created_at">>> {
  const clean = cleanPhone(phone);
  if (!clean) return [];
  await ensureIndexes();
  try {
    const col = await getCollection<PhoneDoc>(COL.WHATSAPP_MESSAGES);
    const doc = await col.findOne({ _id: clean as any });
    const flat = flattenDoc(doc as any);
    flat.reverse();
    return flat.slice(0, limit).map((m) => ({
      message: m.message,
      intent: m.intent,
      direction: m.direction,
      created_at: m.created_at,
    }));
  } catch (err: any) {
    console.error(`[whatsapp_messages] getLastMessagesWithIntent failed: ${err.message}`);
    return [];
  }
}

/** Cron follow-up — scan every phone doc, unwind the given direction. ASC. */
export async function getAllByDirection(
  direction: Direction,
  limit: number = 5000,
): Promise<WhatsappMessage[]> {
  await ensureIndexes();
  try {
    const col = await getCollection(COL.WHATSAPP_MESSAGES);
    const docs = await col.find({}).limit(limit).toArray();
    const out: WhatsappMessage[] = [];
    for (const d of docs as any[]) {
      const flat = flattenDoc(d, { direction });
      for (const m of flat) out.push(m);
    }
    out.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return out.slice(0, limit);
  } catch (err: any) {
    console.error(`[whatsapp_messages] getAllByDirection failed: ${err.message}`);
    return [];
  }
}
