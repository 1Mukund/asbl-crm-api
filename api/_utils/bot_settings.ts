/**
 * Tiny key-value store for bot-level settings.
 *
 * MIGRATED FROM SUPABASE → MongoDB (Phase 1 of the Mongo migration).
 * Collection: "bot_settings" inside the "Zoho Database" Mongo db.
 *
 * Schema (per document):
 *   { _id: <key string>, value: string, updated_at: ISO string }
 *
 * The `_id` is the setting key (e.g. "system_prompt", "zoho_access_token_v1",
 * "use_pdf_extracts"). Mongo enforces uniqueness on _id for free, so this
 * mirrors the old (key TEXT PRIMARY KEY) Postgres constraint exactly.
 *
 * Backfill from Supabase is handled by
 *   POST /api/chat-history?action=mongo-backfill&collection=bot_settings
 * — that route reads the old Supabase rows once and writes them to Mongo
 * so we don't have to re-run anything by hand.
 */

import { getCollection, COL } from "./mongo";

interface BotSettingDoc {
  _id: string;          // setting key
  value: string;
  updated_at: string;   // ISO string
}

/** Get a single setting; returns null if not set. Shape kept compatible
 *  with the old Supabase-backed function so call sites need no changes. */
export async function getBotSetting(
  key: string,
): Promise<{ value: string; updated_at: string } | null> {
  try {
    const col = await getCollection<BotSettingDoc>(COL.BOT_SETTINGS);
    const doc = await col.findOne({ _id: key });
    if (!doc) return null;
    return { value: doc.value, updated_at: doc.updated_at };
  } catch (err: any) {
    console.error(`[bot_settings] read failed: ${err.message}`);
    return null;
  }
}

/** Upsert a setting. */
export async function setBotSetting(
  key: string,
  value: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const col = await getCollection<BotSettingDoc>(COL.BOT_SETTINGS);
    const now = new Date().toISOString();
    await col.updateOne(
      { _id: key },
      { $set: { value, updated_at: now }, $setOnInsert: { _id: key } },
      { upsert: true },
    );
    return { ok: true };
  } catch (err: any) {
    console.error(`[bot_settings] write failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
