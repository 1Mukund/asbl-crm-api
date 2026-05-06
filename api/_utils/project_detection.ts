/**
 * Project detection — resolves which ASBL project a customer message refers to.
 *
 * Priority:
 *   1. Explicit keyword in message (LOFT/SPECTRA/BROADWAY/LANDMARK)
 *   2. LEGACY trigger keywords (rtc x roads, upcoming, pre-rera)
 *   3. Zoho lead's ASBL_Project field
 *   4. Last asked project for this phone (Supabase whatsapp_messages.project)
 *   5. null (no project resolved)
 */

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

export type Project = "LOFT" | "SPECTRA" | "BROADWAY" | "LANDMARK" | "LEGACY";

const KNOWN_PROJECTS: Project[] = ["LOFT", "SPECTRA", "BROADWAY", "LANDMARK"];

const PROJECT_KEYWORDS: Record<Project, string[]> = {
  LOFT:     ["loft"],
  SPECTRA:  ["spectra"],
  BROADWAY: ["broadway", "brodway"],
  LANDMARK: ["landmark", "land mark"],
  LEGACY:   ["rtc x roads", "rtc xroads", "rtc cross", "upcoming project", "pre-rera", "pre rera", "prerera"],
};

// ── Detect project from message text (keyword match) ─────────────────────────
export function detectFromMessage(message: string): Project | null {
  const lower = message.toLowerCase();

  // Check the 4 named projects first (LEGACY is checked separately as fallback intent)
  for (const project of KNOWN_PROJECTS) {
    for (const kw of PROJECT_KEYWORDS[project]) {
      if (lower.includes(kw)) return project;
    }
  }

  // LEGACY trigger phrases
  for (const kw of PROJECT_KEYWORDS.LEGACY) {
    if (lower.includes(kw)) return "LEGACY";
  }

  return null;
}

// ── Get last asked project for phone from Supabase ───────────────────────────
// Looks at last 5 turns from EITHER direction (so a project the bot just
// answered about counts even if the customer's follow-up doesn't repeat the name).
export async function getLastAskedProject(phone: string): Promise<Project | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_messages?phone=eq.${phone}&project=not.is.null&order=created_at.desc&limit=5&select=project,direction,created_at`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    // Take the very latest project tag — project context locks to it
    const proj = rows[0]?.project;
    if (proj && [...KNOWN_PROJECTS, "LEGACY"].includes(proj)) return proj as Project;
    return null;
  } catch (err: any) {
    console.error(`[ProjectDetect] last-asked lookup failed: ${err.message}`);
    return null;
  }
}

// ── Detect "all projects" / multi-project intent ─────────────────────────────
// Returns true when the customer is asking about everything (price across all,
// compare, list of projects, etc.) — caller should inject ALL projects'
// PROJECT_CONTEXT instead of just one.
export function detectMultiProjectIntent(message: string): boolean {
  const m = message.toLowerCase();
  const triggers = [
    "all your projects", "all projects", "all the projects",
    "across all", "across project", "across projects", "every project", "in all",
    "all units", "all sizes", "all options", "all unit plans", "all floor plans",
    "compare", "comparison", "vs ", " versus",
    "list of projects", "tell me about your projects", "what all projects",
    "kaunsa", "kaun sa", "konsa", "kon sa", // hindi: which one
    "all offers", "all schemes",
    // RERA / approval queries across projects
    "all rera", "rera of all", "rera for all", "rera numbers", "every rera",
    // generic "all" across categories often used in our domain
    "for all projects", "of all projects", "from all projects",
    "all the projects", "all 4 projects", "all four projects",
  ];
  return triggers.some((t) => m.includes(t));
}

// ── Resolve final project ─────────────────────────────────────────────────────
// Priority chain (highest first):
//   1. Explicit project keyword in current message — always honor.
//   2. Most recent project tagged on this phone (either direction) in DB.
//      This ensures context follows the BOT's last reply, not just the
//      customer's last keyword. Fixes "Spectra was discussed → customer asks
//      generic question → bot reverts to Loft" regression.
//   3. Zoho lead's ASBL_Project field — only used as a tiebreaker when
//      conversation history is empty.
//   4. null (Gemini will ask which project, or use multi-project context).
export async function resolveProject(opts: {
  message: string;
  zohoProject?: string | null;
  phone: string;
}): Promise<Project | null> {
  // 1. Explicit mention always wins
  const fromMsg = detectFromMessage(opts.message);
  if (fromMsg) return fromMsg;

  // 2. Most recent project from conversation history
  const lastAsked = await getLastAskedProject(opts.phone);
  if (lastAsked) return lastAsked;

  // 3. Zoho field as tiebreaker when no conversation history
  if (opts.zohoProject) {
    const upper = opts.zohoProject.trim().toUpperCase();
    if ([...KNOWN_PROJECTS, "LEGACY"].includes(upper as any)) {
      return upper as Project;
    }
  }

  return null;
}
