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
export async function getLastAskedProject(phone: string): Promise<Project | null> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/whatsapp_messages?phone=eq.${phone}&project=not.is.null&direction=eq.inbound&order=created_at.desc&limit=1&select=project`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    const proj = rows?.[0]?.project;
    if (proj && [...KNOWN_PROJECTS, "LEGACY"].includes(proj)) return proj as Project;
    return null;
  } catch (err: any) {
    console.error(`[ProjectDetect] last-asked lookup failed: ${err.message}`);
    return null;
  }
}

// ── Resolve final project ─────────────────────────────────────────────────────
export async function resolveProject(opts: {
  message: string;
  zohoProject?: string | null; // value of ASBL_Project from Zoho lead
  phone: string;
}): Promise<Project | null> {
  // Priority 1: explicit mention in message
  const fromMsg = detectFromMessage(opts.message);
  if (fromMsg) return fromMsg;

  // Priority 2: Zoho lead's ASBL_Project field
  if (opts.zohoProject) {
    const upper = opts.zohoProject.trim().toUpperCase();
    if ([...KNOWN_PROJECTS, "LEGACY"].includes(upper as any)) {
      return upper as Project;
    }
  }

  // Priority 3: last-asked project for this phone
  const lastAsked = await getLastAskedProject(opts.phone);
  if (lastAsked) return lastAsked;

  return null;
}
