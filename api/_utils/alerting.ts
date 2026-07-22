/**
 * Ops alerting — immediate Microsoft Teams notification on CRITICAL failures.
 *
 * Wired into the top-level catch of the risky paths (posthook, cron, inbound
 * WhatsApp webhook, call trigger, ingest). The moment one of those fails, a
 * card is posted to a Teams channel so ops sees it in real time — no log
 * digging.
 *
 * Rate-limited (deduped) via Mongo so a RECURRING error fires ONE alert per
 * window (default 30 min), not thousands — e.g. the Zoho-rate-limit incident
 * would have produced a single "Zoho auth failing" card, not a flood.
 *
 * Best-effort: never throws (must never break the caller). No-op until
 * TEAMS_WEBHOOK_URL is set (Teams channel → Connectors → Incoming Webhook).
 */
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || "";

/** Returns true if this alert key already fired within the window (→ suppress).
 *  Uses a unique _id per (key, time-window) — a duplicate insert = already
 *  alerted. Records self-expire after 24h via a TTL index. */
async function isRateLimited(key: string, windowMin: number): Promise<boolean> {
  try {
    const { getCollection } = await import("./mongo");
    const col = await getCollection("alert_dedupe" as any);
    if (!(globalThis as any).__alertDedupeIdx) {
      (globalThis as any).__alertDedupeIdx = true;
      col.createIndex({ at: 1 }, { expireAfterSeconds: 86400 }).catch(() => {});
    }
    const bucket = Math.floor(Date.now() / (windowMin * 60_000));
    await col.insertOne({ _id: `${key}:${bucket}` as any, at: new Date() } as any);
    return false; // inserted → first time this window → send
  } catch (err: any) {
    if (err?.code === 11000) return true; // duplicate _id → already alerted
    return false; // any other error → don't suppress the alert
  }
}

async function sendTeams(opts: {
  title: string; message: string; severity: string; context?: Record<string, any>;
}): Promise<void> {
  if (!TEAMS_WEBHOOK_URL) return;
  const color = opts.severity === "warning" ? "E0A800" : "D93F3F";
  const facts = Object.entries(opts.context || {})
    .filter(([, v]) => v !== undefined && v !== null && String(v) !== "")
    .map(([k, v]) => ({ name: k, value: String(v).slice(0, 400) }));
  const card = {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: color,
    summary: `ASBL CRM alert: ${opts.title}`,
    title: `🚨 ASBL CRM — ${opts.title}`,
    sections: [{
      activitySubtitle: new Date().toISOString(),
      text: (opts.message || "").slice(0, 2000),
      facts,
    }],
  };
  await fetch(TEAMS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  }).catch(() => {});
}

/** Fire a critical-failure alert to Teams. Best-effort, deduped, never throws. */
export async function alertOps(opts: {
  title: string;
  message: string;
  severity?: "critical" | "error" | "warning";
  context?: Record<string, any>;
  /** Dedupe signature — same key within the window fires once. Defaults to title. */
  dedupeKey?: string;
  dedupeMinutes?: number;
}): Promise<void> {
  try {
    if (!TEAMS_WEBHOOK_URL) return; // not configured — no-op
    const key = (opts.dedupeKey || opts.title).slice(0, 120);
    if (await isRateLimited(key, opts.dedupeMinutes ?? 30)) return;
    await sendTeams({
      title: opts.title,
      message: opts.message,
      severity: opts.severity || "critical",
      context: opts.context,
    });
  } catch (err: any) {
    console.error("[alertOps] failed:", err?.message);
  }
}
