/**
 * Tiny key-value store for bot-level settings, persisted in Supabase.
 *
 * Currently used for the user-editable Gemini system prompt.
 * Fall through to a hardcoded default when the DB has no override.
 */
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

/** Get a single setting; returns null if not set. */
export async function getBotSetting(key: string): Promise<{ value: string; updated_at: string } | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/bot_settings?key=eq.${encodeURIComponent(key)}&select=value,updated_at`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0] || null;
  } catch (err: any) {
    console.error(`[bot_settings] read failed: ${err.message}`);
    return null;
  }
}

/** Upsert a setting. */
export async function setBotSetting(key: string, value: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bot_settings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
    if (!r.ok) {
      return { ok: false, error: `${r.status}: ${(await r.text()).slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
