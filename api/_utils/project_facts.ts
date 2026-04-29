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
  facts_text: string;
  updated_at: string | null;
}

// ── Read ───────────────────────────────────────────────────────────────────
export async function getProjectFacts(project: string): Promise<ProjectFacts | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/project_facts?project=eq.${project}&select=project,facts_text,updated_at`,
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
      `${SUPABASE_URL}/rest/v1/project_facts?select=project,facts_text,updated_at&order=project.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return [];
    return (await r.json()) || [];
  } catch (err: any) {
    console.error(`[ProjectFacts] list failed: ${err.message}`);
    return [];
  }
}

// ── Write (upsert) ─────────────────────────────────────────────────────────
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
