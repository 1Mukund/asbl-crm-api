/**
 * Project facts — manually-curated rich Knowledge Base per project,
 * stored in Supabase project_facts table.
 *
 * This is the single source of truth for project information that
 * the bot uses as <PROJECT_CONTEXT>. The user maintains it via the
 * dashboard's "Edit KB" form (/api/chat-history?view=edit-facts&project=X).
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

export const KNOWN_PROJECTS = ["LOFT", "SPECTRA", "BROADWAY", "LANDMARK", "LEGACY"] as const;
export type ProjectName = typeof KNOWN_PROJECTS[number];

export interface ProjectFacts {
  project: string;
  /** Curated OFFER details (manually written via dashboard "Edit ✎" form). */
  facts_text: string;
  /** General KB content (auto-extracted from uploaded TXT/PDF). */
  kb_text?: string;
  updated_at: string | null;
  /** When kb_text was last updated (separate from offer's updated_at). */
  kb_updated_at?: string | null;
  kb_pdf_url?: string | null;
}

// ── Read ───────────────────────────────────────────────────────────────────
export async function getProjectFacts(project: string): Promise<ProjectFacts | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_facts?project=eq.${project}&select=project,facts_text,kb_text,updated_at,kb_updated_at,kb_pdf_url`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows?.[0] || null;
  } catch (err: any) {
    console.error(`[ProjectFacts] read failed: ${err.message}`);
    return null;
  }
}

// ── Read all (for dashboard) ──────────────────────────────────────────────
export async function listAllProjectFacts(): Promise<ProjectFacts[]> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_facts?select=project,facts_text,kb_text,updated_at,kb_updated_at,kb_pdf_url&order=project.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return [];
    return (await r.json()) || [];
  } catch (err: any) {
    console.error(`[ProjectFacts] list failed: ${err.message}`);
    return [];
  }
}

// ── Write (upsert) — ONLY touches facts_text (offer details) ──────────────
// IMPORTANT: this does NOT touch kb_text. Use saveProjectKb() for KB uploads.
export async function saveProjectFacts(project: string, factsText: string): Promise<{ ok: boolean; error?: string }> {
  if (!KNOWN_PROJECTS.includes(project as any)) {
    return { ok: false, error: `Unknown project: ${project}` };
  }
  try {
    const body = {
      project,
      facts_text: factsText,
      updated_at: new Date().toISOString(),
    };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/project_facts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: `${r.status}: ${t}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ── Write KB only — does NOT touch facts_text (offer details) ─────────────
// Used by the dashboard upload-kb handler. Updates kb_text + kb_pdf_url.
export async function saveProjectKb(
  project: string,
  kbText: string,
  kbPdfUrl: string | null
): Promise<{ ok: boolean; error?: string }> {
  if (!KNOWN_PROJECTS.includes(project as any)) {
    return { ok: false, error: `Unknown project: ${project}` };
  }
  try {
    // First check if a row exists. If not, we need to insert with empty facts_text
    // so the upsert doesn't fail on NOT NULL. If yes, PATCH only kb_text fields.
    const existing = await getProjectFacts(project);
    const now = new Date().toISOString();

    if (existing) {
      // PATCH only the KB fields — facts_text untouched
      const r = await fetch(`${SUPABASE_URL}/rest/v1/project_facts?project=eq.${project}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          kb_text: kbText,
          kb_updated_at: now,
          ...(kbPdfUrl ? { kb_pdf_url: kbPdfUrl } : {}),
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        return { ok: false, error: `${r.status}: ${t}` };
      }
    } else {
      // No row yet → insert with empty facts_text + kb fields populated
      const r = await fetch(`${SUPABASE_URL}/rest/v1/project_facts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          project,
          facts_text: "",
          kb_text: kbText,
          kb_updated_at: now,
          ...(kbPdfUrl ? { kb_pdf_url: kbPdfUrl } : {}),
          updated_at: now,
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        return { ok: false, error: `${r.status}: ${t}` };
      }
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
