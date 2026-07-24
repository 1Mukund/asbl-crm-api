/**
 * MASTER FREEZE SWITCH — full stop of ALL automation for the logic/DB rebuild.
 *
 * When `bot_settings.automation_frozen === "true"`, every automation entry point
 * no-ops:
 *   - Lead ingestion (inncircles / website / meta / fim) — payload archived to
 *     `frozen_inbox`, NOT written to Mongo/Zoho, no T=0 fanout.
 *   - The cron (prd-cadence stage reconcile + call firing + all tasks).
 *   - The call posthook (result captured, not processed — no status change).
 *   - Reactive WhatsApp replies (inbound saved to history, but no Gemini/reply).
 *   - The T=0 orchestrator fanout (belt-and-suspenders).
 *
 * Flip it with:  GET /api/chat-history?action=set-ops-flag&key=automation_frozen&value=true
 * (value=false to lift the freeze).
 *
 * FAIL-OPEN: a read error returns `false` (not frozen) so a transient Mongo blip
 * can never freeze production by accident. The proactive channels are ALSO gated
 * independently by calls_paused / whatsapp_*_paused, so a fail-open here at worst
 * briefly resumes ingest/reactive/reconcile — never the calls/WhatsApp blasts.
 */
export async function isAutomationFrozen(): Promise<boolean> {
  try {
    const { getBotSetting } = await import("./bot_settings");
    return (await getBotSetting("automation_frozen"))?.value === "true";
  } catch {
    return false;
  }
}

/**
 * Archive a payload we deliberately did NOT process during the freeze, so it can
 * be replayed after the rebuild — nothing is lost. Best-effort, never throws.
 */
export async function archiveFrozen(kind: string, payload: any): Promise<void> {
  try {
    const { getCollection } = await import("./mongo");
    const col = await getCollection("frozen_inbox" as any);
    await col.insertOne({ kind, payload, at: new Date().toISOString() } as any);
  } catch (err: any) {
    console.error(`[freeze] archiveFrozen(${kind}) failed: ${err?.message}`);
  }
}
