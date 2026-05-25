/**
 * user_profiles — per-phone structured memory for the WhatsApp bot.
 *
 * MIGRATED FROM SUPABASE → MongoDB (Phase 2 of the Mongo migration).
 * Collection: "user_profiles" inside the "Zoho_Database" Mongo db.
 *
 * Schema (per document):
 *   _id is the customer's digits-only phone string (functions as PK).
 *   Other fields mirror the v5 spec exactly — see SQL_TO_RUN.md for the
 *   original column list.
 *
 * Each inbound message:
 *   1. fetch the existing profile (or lazy-create with funnel_stage="new")
 *   2. render a <USER_PROFILE> block into the Gemini prompt
 *
 * Each outbound (after Gemini classifies + replies):
 *   3. parse the `extracted_facts` field from Gemini's JSON
 *   4. merge into the profile — scalars OVERWRITE if new value is non-null,
 *      arrays APPEND + DEDUPE
 *   5. bump funnel_stage if a stage-advancing signal fired
 *   6. (when a PDF actually gets sent) append doc_meta to docs_sent
 *
 * Backfill from Supabase:
 *   POST /api/chat-history?action=mongo-backfill&collection=user_profiles&secret=<...>
 */

import { getCollection, COL } from "./mongo";

// ─── Types ────────────────────────────────────────────────────────────────

export type FunnelStage =
  | "new"
  | "engaged"
  | "qualified"
  | "brochure_sent"
  | "cost_sheet_sent"
  | "visit_scheduled"
  | "visit_done"
  | "negotiating"
  | "booked"
  | "lost";

/** Ordered for monotonic stage progression. Later index = further down funnel.
 *  "lost" is terminal (any signal can move TO lost, but lost never auto-moves). */
const STAGE_ORDER: FunnelStage[] = [
  "new",
  "engaged",
  "qualified",
  "brochure_sent",
  "cost_sheet_sent",
  "visit_scheduled",
  "visit_done",
  "negotiating",
  "booked",
];

export interface UserProfile {
  phone: string;
  name: string | null;
  budget_cr: number | null;
  intent: string | null;
  preferred_size_sft: number | null;
  preferred_bhk: number | null;
  preferred_facing: string | null;
  family_size: number | null;
  work_location: string | null;
  timeline: string | null;
  objections_raised: string[];
  commitments_made: string[];
  docs_sent: string[];
  preferred_language: string | null;
  current_project: string | null;
  last_project: string | null;
  last_interaction_at: string | null;
  funnel_stage: FunnelStage;
  /** Per-phone bot kill-switch. When false, the WhatsApp webhook still
   *  logs incoming messages but does NOT call Gemini / send any reply.
   *  Defaults to true (bot enabled) on profile creation. Operator can flip
   *  via dashboard's "Turn off bot" toggle next to each phone. */
  bot_enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** Mongo document shape — same as UserProfile but with _id PK = phone. */
interface UserProfileDoc extends UserProfile {
  _id: string;  // phone digits
}

/** Shape Gemini returns under the `extracted_facts` key in its JSON output.
 *  All scalars are nullable; we only merge non-null values. */
export interface ExtractedFacts {
  name?: string | null;
  budget_cr?: number | null;
  intent?: string | null;
  preferred_size_sft?: number | null;
  preferred_bhk?: number | null;
  preferred_facing?: string | null;
  family_size?: number | null;
  work_location?: string | null;
  timeline?: string | null;
  new_objection?: string | null;
  new_commitment?: string | null;
  preferred_language?: string | null;
}

const SCALAR_FIELDS: (keyof UserProfile & keyof ExtractedFacts)[] = [
  "name",
  "budget_cr",
  "intent",
  "preferred_size_sft",
  "preferred_bhk",
  "preferred_facing",
  "family_size",
  "work_location",
  "timeline",
  "preferred_language",
];

// ─── Read ─────────────────────────────────────────────────────────────────

function cleanPhone(p: string): string {
  return String(p || "").replace(/\D/g, "");
}

export async function getProfile(phone: string): Promise<UserProfile | null> {
  const clean = cleanPhone(phone);
  if (!clean) return null;
  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    const doc = await col.findOne({ _id: clean });
    return doc ? normalizeProfileFromDb(doc) : null;
  } catch (err: any) {
    console.error(`[UserProfile] getProfile failed: ${err.message}`);
    return null;
  }
}

/** Get-or-create. New rows start as funnel_stage="new" with no facts. */
export async function getOrCreateProfile(phone: string): Promise<UserProfile> {
  const clean = cleanPhone(phone);
  const existing = await getProfile(clean);
  if (existing) return existing;

  const now = new Date().toISOString();
  const blank: UserProfileDoc = {
    _id: clean,
    phone: clean,
    name: null,
    budget_cr: null,
    intent: null,
    preferred_size_sft: null,
    preferred_bhk: null,
    preferred_facing: null,
    family_size: null,
    work_location: null,
    timeline: null,
    objections_raised: [],
    commitments_made: [],
    docs_sent: [],
    preferred_language: null,
    current_project: null,
    last_project: null,
    last_interaction_at: null,
    funnel_stage: "new",
    bot_enabled: true,
    created_at: now,
    updated_at: now,
  };

  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    // upsert with $setOnInsert so we don't trample an existing row in
    // a race between two concurrent webhook invocations.
    await col.updateOne(
      { _id: clean },
      { $setOnInsert: blank },
      { upsert: true },
    );
    // Re-read to get whatever version actually persisted (in the race,
    // ours may have been replaced by the other invocation's blank doc).
    const final = await col.findOne({ _id: clean });
    return final ? normalizeProfileFromDb(final) : normalizeProfileFromDb(blank as any);
  } catch (err: any) {
    console.error(`[UserProfile] lazy-create failed: ${err.message}`);
    return normalizeProfileFromDb(blank as any);
  }
}

function normalizeProfileFromDb(row: any): UserProfile {
  return {
    phone: String(row.phone || row._id || ""),
    name: row.name ?? null,
    budget_cr: row.budget_cr === null || row.budget_cr === undefined ? null : Number(row.budget_cr),
    intent: row.intent ?? null,
    preferred_size_sft: row.preferred_size_sft ?? null,
    preferred_bhk: row.preferred_bhk === null || row.preferred_bhk === undefined ? null : Number(row.preferred_bhk),
    preferred_facing: row.preferred_facing ?? null,
    family_size: row.family_size ?? null,
    work_location: row.work_location ?? null,
    timeline: row.timeline ?? null,
    objections_raised: Array.isArray(row.objections_raised) ? row.objections_raised : [],
    commitments_made: Array.isArray(row.commitments_made) ? row.commitments_made : [],
    docs_sent: Array.isArray(row.docs_sent) ? row.docs_sent : [],
    preferred_language: row.preferred_language ?? null,
    current_project: row.current_project ?? null,
    last_project: row.last_project ?? null,
    last_interaction_at: row.last_interaction_at ?? null,
    funnel_stage: (row.funnel_stage as FunnelStage) || "new",
    // Default to true for legacy docs that pre-date the toggle. Only explicit
    // `false` (set by the dashboard turn-off action) silences the bot.
    bot_enabled: row.bot_enabled === false ? false : true,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

// ─── Merge extracted_facts ────────────────────────────────────────────────

/** Returns the merge DELTA (only the fields that actually changed) — useful
 *  for the PATCH body. Scalars: new value wins if non-null AND different.
 *  Arrays: append + dedupe (case-insensitive) when a new_* string is present. */
export function diffExtractedFacts(
  existing: UserProfile,
  facts: ExtractedFacts | null | undefined,
): Partial<UserProfile> {
  const delta: Partial<UserProfile> = {};
  if (!facts || typeof facts !== "object") return delta;

  for (const f of SCALAR_FIELDS) {
    const incoming = (facts as any)[f];
    if (incoming === null || incoming === undefined || incoming === "") continue;
    if (typeof incoming === "string" && incoming.trim().toLowerCase() === "null") continue;
    const current = (existing as any)[f];
    if (typeof incoming === "number" && typeof current === "number") {
      if (incoming !== current) (delta as any)[f] = incoming;
    } else if (String(incoming).trim() !== String(current ?? "").trim()) {
      (delta as any)[f] = typeof incoming === "string" ? incoming.trim() : incoming;
    }
  }

  const newObj = sanitizeListItem(facts.new_objection);
  if (newObj && !containsCi(existing.objections_raised, newObj)) {
    delta.objections_raised = [...existing.objections_raised, newObj];
  }
  const newCom = sanitizeListItem(facts.new_commitment);
  if (newCom && !containsCi(existing.commitments_made, newCom)) {
    delta.commitments_made = [...existing.commitments_made, newCom];
  }

  return delta;
}

function sanitizeListItem(s: string | null | undefined): string {
  if (!s) return "";
  const t = String(s).trim();
  if (!t || t.toLowerCase() === "null") return "";
  return t.length > 200 ? t.slice(0, 200) : t;
}

function containsCi(arr: string[], item: string): boolean {
  const target = item.toLowerCase();
  return arr.some((x) => String(x).toLowerCase() === target);
}

// ─── Write ────────────────────────────────────────────────────────────────

export async function mergeProfile(
  phone: string,
  existing: UserProfile,
  delta: Partial<UserProfile>,
): Promise<UserProfile> {
  const clean = cleanPhone(phone);
  const now = new Date().toISOString();
  const fullDelta: Partial<UserProfile> = {
    ...delta,
    last_interaction_at: now,
    updated_at: now,
  };

  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    await col.updateOne(
      { _id: clean },
      { $set: fullDelta as any },
    );
  } catch (err: any) {
    console.error(`[UserProfile] mergeProfile threw: ${err.message}`);
  }

  return { ...existing, ...fullDelta } as UserProfile;
}

// ─── Funnel stage progression ─────────────────────────────────────────────

export type FunnelSignal =
  | "INBOUND_MSG"
  | "FACTS_CAPTURED"
  | "DOC_BROCHURE_SENT"
  | "DOC_PRICE_SHEET_SENT"
  | "SITE_VISIT_SCHEDULED"
  | "SITE_VISIT_DONE"
  | "NEGOTIATING"
  | "BOOKED"
  | "LOST";

export function nextFunnelStage(
  current: FunnelStage,
  signal: FunnelSignal,
): FunnelStage {
  if (current === "booked" || current === "lost") return current;
  if (signal === "LOST") return "lost";

  const target: FunnelStage =
    signal === "INBOUND_MSG"             ? "engaged"
    : signal === "FACTS_CAPTURED"        ? "qualified"
    : signal === "DOC_BROCHURE_SENT"     ? "brochure_sent"
    : signal === "DOC_PRICE_SHEET_SENT"  ? "cost_sheet_sent"
    : signal === "SITE_VISIT_SCHEDULED"  ? "visit_scheduled"
    : signal === "SITE_VISIT_DONE"       ? "visit_done"
    : signal === "NEGOTIATING"           ? "negotiating"
    : signal === "BOOKED"                ? "booked"
    : current;

  const curIdx = STAGE_ORDER.indexOf(current);
  const tgtIdx = STAGE_ORDER.indexOf(target);
  return tgtIdx > curIdx ? target : current;
}

export function inferQualifiedSignal(merged: UserProfile): FunnelSignal | null {
  const hasBudget = merged.budget_cr !== null;
  const hasSizeAndTimeline = merged.preferred_size_sft !== null && !!merged.timeline;
  if (hasBudget || hasSizeAndTimeline) return "FACTS_CAPTURED";
  return null;
}

export async function advanceFunnel(
  phone: string,
  current: FunnelStage,
  signal: FunnelSignal,
): Promise<FunnelStage> {
  const target = nextFunnelStage(current, signal);
  if (target === current) return current;

  const clean = cleanPhone(phone);
  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    await col.updateOne(
      { _id: clean },
      { $set: { funnel_stage: target, updated_at: new Date().toISOString() } },
    );
    console.log(`[UserProfile] funnel ${current} → ${target} (signal=${signal}) phone=${clean}`);
  } catch (err: any) {
    console.error(`[UserProfile] advanceFunnel threw: ${err.message}`);
  }
  return target;
}

// ─── Doc tracking ─────────────────────────────────────────────────────────

export async function appendDocSent(
  phone: string,
  docType: string,
  docMeta: { unit_size_sft?: number | null; facing?: string | null; tower?: string | null } | null,
  existingDocsSent: string[],
): Promise<string[]> {
  const tag = formatDocTag(docType, docMeta);
  if (containsCi(existingDocsSent, tag)) return existingDocsSent;

  const next = [...existingDocsSent, tag];
  const clean = cleanPhone(phone);
  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    // $addToSet keeps the array deduped if there's a race with another invocation
    await col.updateOne(
      { _id: clean },
      {
        $addToSet: { docs_sent: tag } as any,
        $set: { updated_at: new Date().toISOString() },
      },
    );
  } catch (err: any) {
    console.error(`[UserProfile] appendDocSent threw: ${err.message}`);
  }
  return next;
}

function formatDocTag(
  docType: string,
  meta: { unit_size_sft?: number | null; facing?: string | null; tower?: string | null } | null,
): string {
  if (!meta) return docType;
  const parts: string[] = [];
  if (meta.unit_size_sft) parts.push(String(meta.unit_size_sft));
  if (meta.facing) parts.push(String(meta.facing).toLowerCase());
  if (meta.tower) parts.push(String(meta.tower));
  return parts.length ? `${docType}:${parts.join("-")}` : docType;
}

export async function setActiveProject(
  phone: string,
  existing: UserProfile,
  resolved: string | null,
): Promise<UserProfile> {
  if (!resolved) return existing;
  if (existing.current_project === resolved) return existing;

  const clean = cleanPhone(phone);
  const delta: Partial<UserProfile> = {
    current_project: resolved,
    last_project: existing.current_project || existing.last_project,
    updated_at: new Date().toISOString(),
  };
  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    await col.updateOne({ _id: clean }, { $set: delta as any });
  } catch (err: any) {
    console.error(`[UserProfile] setActiveProject threw: ${err.message}`);
  }
  return { ...existing, ...delta } as UserProfile;
}

// ─── <USER_PROFILE> block renderer (unchanged from Supabase version) ─────

export function renderUserProfileBlock(p: UserProfile): string {
  const lines: string[] = [];
  const push = (k: string, v: any) => {
    if (v === null || v === undefined) return;
    if (typeof v === "string" && !v.trim()) return;
    if (Array.isArray(v) && !v.length) return;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(" | ") : v}`);
  };

  push("phone", p.phone);
  push("name", p.name);
  push("budget_cr", p.budget_cr);
  push("intent", p.intent);
  push("preferred_size_sft", p.preferred_size_sft);
  push("preferred_bhk", p.preferred_bhk);
  push("preferred_facing", p.preferred_facing);
  push("family_size", p.family_size);
  push("work_location", p.work_location);
  push("timeline", p.timeline);
  push("preferred_language", p.preferred_language);
  push("current_project", p.current_project);
  push("last_project", p.last_project);
  push("funnel_stage", p.funnel_stage);
  push("objections_raised", p.objections_raised);
  push("commitments_made", p.commitments_made);
  push("docs_sent", p.docs_sent);
  if (p.last_interaction_at) push("last_interaction_at", p.last_interaction_at);

  return lines.length ? lines.join("\n") : "(no profile yet — first interaction)";
}

// ─── Bot kill-switch + dashboard list ─────────────────────────────────────

/** Flip the per-phone bot toggle. Returns the new enabled state. */
export async function setBotEnabled(
  phone: string,
  enabled: boolean,
): Promise<boolean> {
  const clean = cleanPhone(phone);
  if (!clean) return enabled;
  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    // Upsert so the toggle works even if the operator flips a number we
    // haven't received a message from yet (rare but supported).
    await col.updateOne(
      { _id: clean as any },
      {
        $set: { bot_enabled: enabled, updated_at: new Date().toISOString() },
        $setOnInsert: {
          _id: clean,
          phone: clean,
          funnel_stage: "new",
          created_at: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    console.log(`[UserProfile] bot_enabled=${enabled} for phone=${clean}`);
    return enabled;
  } catch (err: any) {
    console.error(`[UserProfile] setBotEnabled threw: ${err.message}`);
    return enabled;
  }
}

/** List all user profiles for the dashboard — newest-interaction first.
 *  Used to render the "Bot Override" section with one row per phone the
 *  bot has talked to. */
export async function listAllProfiles(limit: number = 500): Promise<UserProfile[]> {
  try {
    const col = await getCollection<UserProfileDoc>(COL.USER_PROFILES);
    const cursor = col
      .find({})
      .sort({ last_interaction_at: -1, updated_at: -1 })
      .limit(limit);
    const docs = await cursor.toArray();
    return docs.map((d: any) => normalizeProfileFromDb(d));
  } catch (err: any) {
    console.error(`[UserProfile] listAllProfiles failed: ${err.message}`);
    return [];
  }
}

