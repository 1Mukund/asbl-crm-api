/**
 * Audit log — records every mutating dashboard action.
 *
 * Collection: "audit_logs" in "Zoho_Database" Mongo db.
 *   { _id, ts, actor_email, action, target, summary, details, ip }
 *
 * Every delete / edit / upload / toggle / approval goes through logAudit so
 * the admin can answer: who changed what, when, and what the old/new value
 * was. Append-only — never updated or deleted from the app.
 */

import { getCollection } from "./mongo";

const COL_AUDIT = "audit_logs";

export interface AuditEntry {
  actor_email: string;
  /** Short machine action, e.g. "delete-doc", "save-prompt", "toggle-bot",
   *  "upload-finalize", "approve-user", "login", "save-facts". */
  action: string;
  /** What was acted on, e.g. "project_documents/<id>", "LOFT offer text",
   *  "phone 9198...". */
  target: string;
  /** One-line human summary shown in the audit table. */
  summary: string;
  /** Optional structured before/after or extra context. */
  details?: any;
  ip?: string | null;
}

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const col = await getCollection(COL_AUDIT);
    await col.insertOne({
      ts: new Date().toISOString(),
      actor_email: entry.actor_email || "(unknown)",
      action: entry.action,
      target: entry.target || "",
      summary: entry.summary || "",
      details: entry.details ?? null,
      ip: entry.ip ?? null,
    } as any);
  } catch (err: any) {
    // Audit logging must never break the underlying action.
    console.error(`[audit] logAudit failed: ${err.message}`);
  }
}

export interface AuditRow {
  ts: string;
  actor_email: string;
  action: string;
  target: string;
  summary: string;
  details: any;
  ip: string | null;
}

export async function listAuditLogs(limit: number = 200): Promise<AuditRow[]> {
  try {
    const col = await getCollection(COL_AUDIT);
    const rows = await col.find({}).sort({ ts: -1 }).limit(limit).toArray();
    return rows as any;
  } catch (err: any) {
    console.error(`[audit] listAuditLogs failed: ${err.message}`);
    return [];
  }
}

/** Best-effort client IP from Vercel/Node request headers. */
export function clientIp(req: any): string | null {
  const xff = req?.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff) return xff.split(",")[0].trim();
  if (Array.isArray(xff) && xff.length) return String(xff[0]).split(",")[0].trim();
  return req?.headers?.["x-real-ip"] || null;
}
