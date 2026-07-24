/**
 * crm_model.ts — Event-sourced CRM write helpers (rebuild v1).
 * ============================================================
 *
 * Implements the APPROVED database architecture:
 *
 *   persons              — 1 per phone (identity + running profile)
 *   crm_leads            — current-state projection, 1 per person×project
 *   lead_events          — APPEND-ONLY immutable timeline (the design's heart)
 *   calls                — 1 doc per dial
 *   messages             — WhatsApp in/out, phone-level
 *   site_visits          — 1 doc per booking
 *   stale_person_record  — not-interested Inncircles siblings (hidden)
 *
 * Two layers:
 *   • HISTORY  = lead_events. Every state change appends ONE immutable row.
 *                Never updated, never deleted. "Sab dikhta hai."
 *   • NOW      = crm_leads / persons. Rebuilt (projected) from events after
 *                each append. Fast reads + dashboards + cron.
 *
 * THE GOLDEN RULE (see appendEvent): a lead's state NEVER changes without an
 * event. Every public mutator here does (a) appendEvent, then (b) project the
 * current-state doc. Callers should go through these helpers, never poke the
 * collections directly.
 *
 * Isolation: the current-state collection is COL.CRM_LEADS ("crm_leads"), NOT
 * the legacy COL.LEADS ("leads") flat Zoho mirror — the two coexist during the
 * rebuild so nothing in the (frozen) automation is disturbed.
 *
 * Everything is best-effort-safe: helpers throw only on programmer error
 * (missing ids); call sites that must not fail ingest wrap in try/catch.
 */

import { getCrmCollection, getCrmNextSequence, getCollection, COL } from "./mongo";
import { getConversationContext } from "./conversation_context";

// ─── Enums (string unions + runtime arrays) ────────────────────────────────

export type Stage =
  | "new" | "contacted" | "engaged" | "qualified"
  | "visit_scheduled" | "visit_done" | "negotiation" | "booked"
  | "not_interested" | "lost" | "spam";

export type Status =
  | "never_contacted" | "attempting" | "connected" | "unreachable" | "dnd";

export type EventType =
  | "lead_created" | "stage_change" | "status_change"
  | "call_scheduled" | "call_completed"
  | "wa_inbound" | "wa_outbound" | "doc_sent"
  | "visit_booked" | "visit_done"
  | "activation" | "primary_caller_shifted"
  | "assignment" | "note" | "system";

export type Actor = "system" | "cron" | "bot" | "customer" | (string & {}); // rm:<id>
export type Channel = "call" | "whatsapp" | "crm" | "system";

export type ActivationType = "fresh" | "reactivated" | "born_in_other" | "bulk";

/** Terminal stages — no automation past these. */
export const TERMINAL_STAGES: Stage[] = ["booked", "not_interested", "lost", "spam"];
/** Milestone (sticky) stages — automation must not drop the lead below these. */
export const MILESTONE_STAGES: Stage[] = ["visit_scheduled", "visit_done", "negotiation", "booked"];

export function isTerminalStage(s?: string | null): boolean {
  return !!s && (TERMINAL_STAGES as string[]).includes(s);
}

// ─── Small utils ───────────────────────────────────────────────────────────

function digits(p?: string | null): string {
  return String(p || "").replace(/\D/g, "");
}
export function normProject(p?: string | null): string {
  const v = String(p || "UNKNOWN").trim().toUpperCase();
  return v || "UNKNOWN";
}
export function personIdOf(phone: string): string {
  return digits(phone);
}
export function leadIdOf(personId: string, project?: string | null): string {
  return `${personId}:${normProject(project)}`;
}
function nowISO(): string {
  return new Date().toISOString();
}
/** Best-effort → epoch ms for ordering. null/invalid → -Infinity. */
function ts(v: any): number {
  if (!v) return -Infinity;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

// ─── Index management (idempotent, guarded) ────────────────────────────────

/**
 * Create every index in the approved indexing plan. createIndex is idempotent
 * so this is a no-op once built; guarded by a per-warm-instance flag so only
 * the first model write touches it. Never throws to the caller.
 */
export async function ensureCrmIndexes(): Promise<void> {
  const G = globalThis as any;
  if (G.__crmIdxEnsured) return;
  G.__crmIdxEnsured = true;
  try {
    const [persons, leads, events, calls, messages, visits, stale, orchestratorCtx] = await Promise.all([
      getCrmCollection(COL.PERSONS),
      getCrmCollection(COL.CRM_LEADS),
      getCrmCollection(COL.LEAD_EVENTS),
      getCrmCollection(COL.CALLS),
      getCrmCollection(COL.CRM_MESSAGES),
      getCrmCollection(COL.SITE_VISITS),
      getCrmCollection(COL.STALE_PERSON_RECORD),
      getCrmCollection(COL.ORCHESTRATOR_CONTEXT),
    ]);
    await Promise.all([
      // persons ( _id (phone) is the automatic unique index )
      persons.createIndex({ primary_caller_lead_id: 1 }, { name: "idx_persons_primary" }),
      // crm_leads
      leads.createIndex({ person_id: 1 }, { name: "idx_leads_person" }),
      leads.createIndex({ stage: 1, next_action_at: 1 }, { name: "idx_leads_stage_next" }),
      // Both is_primary (arch's documented cron query) and is_primary_caller
      // (the semantic call-track flag) are kept in sync on the doc; index both
      // so whichever the cron filters on hits an index — never a full scan.
      leads.createIndex({ is_primary: 1, next_action_at: 1 }, { name: "idx_leads_primary_next" }),
      leads.createIndex({ is_primary_caller: 1, next_action_at: 1 }, { name: "idx_leads_primarycaller_next" }),
      leads.createIndex({ "external.zoho_lead_id": 1 }, { name: "idx_leads_zoho", sparse: true }),
      // lead_events — {lead_id,seq} unique is the single most important index
      events.createIndex({ lead_id: 1, seq: 1 }, { name: "idx_events_lead_seq", unique: true }),
      events.createIndex({ person_id: 1, ts: 1 }, { name: "idx_events_person_ts" }),
      events.createIndex({ type: 1, ts: 1 }, { name: "idx_events_type_ts" }),
      events.createIndex({ lead_id: 1, type: 1, ts: 1 }, { name: "idx_events_lead_type_ts" }),
      // calls
      calls.createIndex({ lead_id: 1 }, { name: "idx_calls_lead" }),
      calls.createIndex({ outcome: 1, dialed_at: 1 }, { name: "idx_calls_outcome_dialed" }),
      calls.createIndex({ scheduled_at: 1 }, { name: "idx_calls_scheduled" }),
      // messages
      messages.createIndex({ person_id: 1, ts: -1 }, { name: "idx_msg_person_ts" }),
      messages.createIndex({ direction: 1, ts: 1 }, { name: "idx_msg_dir_ts" }),
      // site_visits
      visits.createIndex({ lead_id: 1 }, { name: "idx_visits_lead" }),
      visits.createIndex({ status: 1, scheduled_for: 1 }, { name: "idx_visits_status_for" }),
      // stale_person_record
      stale.createIndex({ person_id: 1 }, { name: "idx_stale_person" }),
      stale.createIndex({ person_id: 1, inncircles_born_date: 1 }, { name: "idx_stale_person_born" }),
      // orchestrator_context (§16) — person/lead history + retry-dedupe.
      orchestratorCtx.createIndex({ person_id: 1, ts: 1 }, { name: "idx_octx_person_ts" }),
      orchestratorCtx.createIndex({ lead_id: 1, ts: 1 }, { name: "idx_octx_lead_ts" }),
      orchestratorCtx.createIndex({ interaction_id: 1 }, { name: "idx_octx_interaction", unique: true }),
    ]);
    // frozen_inbox {at} TTL (§7 / §3.9). archiveFrozen() in automation_freeze.ts
    // writes this collection via getCollection → it lives in the LEGACY
    // Zoho_Database, so the TTL index MUST be built on THAT db (index and data
    // must co-locate). `at` is a BSON Date, so the 30-day TTL fires. Nested in
    // its own try so a failure here can't disturb the CRM-db index build above.
    try {
      const frozen = await getCollection(COL.FROZEN_INBOX);
      await frozen.createIndex({ at: 1 }, { name: "idx_frozen_inbox_ttl", expireAfterSeconds: 2592000 });
    } catch (ferr: any) {
      console.error(`[crm_model] frozen_inbox TTL index failed: ${ferr.message}`);
    }
  } catch (err: any) {
    (globalThis as any).__crmIdxEnsured = false; // allow a later retry
    console.error(`[crm_model] ensureCrmIndexes failed: ${err.message}`);
  }
}

/** Force-(re)create every CRM index now; returns names per collection. Backs
 *  the admin ensure-crm-indexes flow — immediate + verifiable. */
export async function ensureCrmIndexesNow(): Promise<Record<string, string[]>> {
  (globalThis as any).__crmIdxEnsured = false;
  await ensureCrmIndexes();
  const out: Record<string, string[]> = {};
  for (const name of [
    COL.PERSONS, COL.CRM_LEADS, COL.LEAD_EVENTS, COL.CALLS,
    COL.CRM_MESSAGES, COL.SITE_VISITS, COL.STALE_PERSON_RECORD,
    COL.ORCHESTRATOR_CONTEXT,
  ]) {
    try {
      const col = await getCrmCollection(name);
      const idx = await col.listIndexes().toArray();
      out[name] = idx.map((i: any) => i.name);
    } catch (err: any) {
      out[name] = [`error: ${err.message}`];
    }
  }
  // frozen_inbox lives in the LEGACY Zoho_Database (see ensureCrmIndexes), so
  // report it from there, not the CRM db.
  try {
    const frozen = await getCollection(COL.FROZEN_INBOX);
    const idx = await frozen.listIndexes().toArray();
    out["frozen_inbox (Zoho_Database)"] = idx.map((i: any) => i.name);
  } catch (err: any) {
    out["frozen_inbox (Zoho_Database)"] = [`error: ${err.message}`];
  }
  return out;
}

// ─── lead_events — the append-only writer ──────────────────────────────────

export interface EventInput {
  lead_id: string;
  person_id: string;
  project: string;
  type: EventType;
  ts?: Date | string;
  actor?: Actor;
  channel?: Channel;
  from?: { stage?: string; status?: string };
  to?: { stage?: string; status?: string };
  reason?: string;
  ref?: string;
  data?: Record<string, any>;
}

export interface EventDoc extends EventInput {
  seq: number;
  ts: string;
}

/**
 * Append ONE immutable event to lead_events. Allocates a per-lead monotonic
 * `seq` via the atomic _counters collection (unique {lead_id,seq} index also
 * blocks accidental duplicates). This is the ONLY function that writes events;
 * it never updates or deletes. Returns the persisted event (with its seq).
 */
export async function appendEvent(evt: EventInput): Promise<EventDoc> {
  if (!evt.lead_id) throw new Error("appendEvent: empty lead_id");
  void ensureCrmIndexes();
  const seq = await getCrmNextSequence(`crm_ev:${evt.lead_id}`, 1);
  const doc: any = {
    lead_id: evt.lead_id,
    person_id: evt.person_id,
    project: evt.project,
    seq,
    ts: evt.ts ? new Date(evt.ts).toISOString() : nowISO(),
    type: evt.type,
    actor: evt.actor ?? "system",
    channel: evt.channel ?? "system",
  };
  if (evt.from) doc.from = evt.from;
  if (evt.to) doc.to = evt.to;
  if (evt.reason) doc.reason = evt.reason;
  if (evt.ref) doc.ref = evt.ref;
  if (evt.data) doc.data = evt.data;
  const col = await getCrmCollection(COL.LEAD_EVENTS);
  await col.insertOne(doc as any);
  return doc as EventDoc;
}

/** Read a lead's full timeline in order. */
export async function getLeadTimeline(leadId: string): Promise<EventDoc[]> {
  const col = await getCrmCollection(COL.LEAD_EVENTS);
  return (await col.find({ lead_id: leadId } as any).sort({ seq: 1 }).toArray()) as any;
}

/**
 * True if an event of this (lead_id, type, ref) already exists. Detail docs
 * (calls / messages / site_visits) are deduped by _id, but the *event* append
 * and its counter $inc must ALSO fire at most once per external ref — otherwise
 * a provider/webhook retry (same call_id / message_id / visit_id) double-appends
 * history and double-counts counters (§10 "idempotent where it matters").
 *
 * When `ref` is absent we can't distinguish a retry from a legitimate repeat, so
 * we return false and let the append proceed (e.g. a doc deliberately re-sent
 * with no external id).
 */
async function eventExistsByRef(leadId: string, type: EventType, ref?: string): Promise<boolean> {
  if (!ref) return false;
  const col = await getCrmCollection(COL.LEAD_EVENTS);
  const hit = await col.findOne({ lead_id: leadId, type, ref } as any, { projection: { _id: 1 } });
  return !!hit;
}

// ─── projection helper ─────────────────────────────────────────────────────

/** Apply a projection update to the crm_leads current-state doc. `seq` marks
 *  how far the projection has advanced (via $max so it's monotonic). */
async function projectLead(
  leadId: string,
  seq: number,
  set: Record<string, any>,
  inc?: Record<string, number>,
): Promise<void> {
  const col = await getCrmCollection(COL.CRM_LEADS);
  const update: any = {
    $set: { ...set, updated_at: nowISO() },
    $max: { event_seq: seq },
  };
  if (inc && Object.keys(inc).length) update.$inc = inc;
  await col.updateOne({ _id: leadId } as any, update, { upsert: false });
}

// ─── persons ───────────────────────────────────────────────────────────────

export interface PersonInput {
  phone: string;
  name?: string;
  email?: string;
  language?: string;
  prefs?: Record<string, any>; // budget_min, budget_max, size, config, facing, timeline, purpose
  project?: string;            // enquiry project → denorm into persons.projects[]
}

/** Upsert the person (phone-level). Never overwrites known fields with blanks;
 *  accumulates emails + projects via $addToSet; merges prefs. */
export async function upsertPerson(input: PersonInput): Promise<string> {
  const personId = personIdOf(input.phone);
  if (!personId) throw new Error("upsertPerson: empty phone");
  void ensureCrmIndexes();
  const now = nowISO();

  const set: Record<string, any> = { updated_at: now };
  if (input.name && input.name.trim()) set.name = input.name.trim();
  if (input.language) set.language = input.language;
  if (input.prefs) {
    for (const [k, v] of Object.entries(input.prefs)) {
      if (v !== undefined && v !== null && v !== "") set[`prefs.${k}`] = v;
    }
  }
  const addToSet: Record<string, any> = {};
  if (input.email && input.email.trim()) addToSet.emails = input.email.trim().toLowerCase();
  if (input.project) addToSet.projects = normProject(input.project);

  const update: any = {
    $setOnInsert: { _id: personId, first_seen_at: now, do_not_contact: false },
    $set: set,
  };
  if (Object.keys(addToSet).length) update.$addToSet = addToSet;

  const col = await getCrmCollection(COL.PERSONS);
  await col.updateOne({ _id: personId } as any, update, { upsert: true });
  return personId;
}

// ─── Inncircles activation classification ──────────────────────────────────

export interface ActivationFlags {
  is_born_fresh?: boolean;
  is_reactivated?: boolean;
  is_born_in_other_project?: boolean;
  is_bulk_transfer?: boolean;
}

export interface Classification {
  active: boolean;
  activation_type: ActivationType | null;
  /** the four flags, coerced to explicit booleans for storage */
  flags: Required<ActivationFlags>;
  stale_reason: "not_interested_sibling" | null;
}

/**
 * The Inncircles rule. Each of the 4 activation flags => active + callable
 * (they differ only in "why", captured as activation_type). All four false
 * (an explicit not-interested sibling) => stale_person_record. Missing flags
 * entirely (non-Inncircles source: website/meta/fim, or Inncircles omitting
 * them) => treat as a normal fresh active lead.
 *
 * When (defensively) more than one flag is true, priority is
 * fresh > reactivated > born_in_other > bulk.
 */
export function classifyActivation(flags?: ActivationFlags | null): Classification {
  const f = flags || {};
  const fresh = f.is_born_fresh === true;
  const react = f.is_reactivated === true;
  const other = f.is_born_in_other_project === true;
  const bulk = f.is_bulk_transfer === true;

  const coerced: Required<ActivationFlags> = {
    is_born_fresh: fresh,
    is_reactivated: react,
    is_born_in_other_project: other,
    is_bulk_transfer: bulk,
  };

  if (fresh) return { active: true, activation_type: "fresh", flags: coerced, stale_reason: null };
  if (react) return { active: true, activation_type: "reactivated", flags: coerced, stale_reason: null };
  if (other) return { active: true, activation_type: "born_in_other", flags: coerced, stale_reason: null };
  if (bulk) return { active: true, activation_type: "bulk", flags: coerced, stale_reason: null };

  // No flag true. Distinguish "explicit all-false" (Inncircles sibling → stale)
  // from "no flag info at all" (normal source → fresh active).
  const anyProvided =
    f.is_born_fresh !== undefined || f.is_reactivated !== undefined ||
    f.is_born_in_other_project !== undefined || f.is_bulk_transfer !== undefined;

  if (anyProvided) {
    // present but all false → not-interested sibling → stale
    return { active: false, activation_type: null, flags: coerced, stale_reason: "not_interested_sibling" };
  }
  // no flags supplied → a plain new enquiry, active as "fresh"
  return { active: true, activation_type: "fresh", flags: coerced, stale_reason: null };
}

// ─── primary-caller recompute (multiple-active → latest wins) ───────────────

/** Order two active leads: primary = latest-activated, tiebreak
 *  inncircles_born_date > born_at > lead_id. Returns <0 if a should sort
 *  BEFORE b (a is "more primary"). */
function comparePrimary(a: any, b: any): number {
  const byActivated = ts(b.activated_at) - ts(a.activated_at);
  if (byActivated !== 0) return byActivated;
  const byInnc = ts(b.inncircles_born_date) - ts(a.inncircles_born_date);
  if (byInnc !== 0) return byInnc;
  const byBorn = ts(b.born_at) - ts(a.born_at);
  if (byBorn !== 0) return byBorn;
  return String(a._id).localeCompare(String(b._id));
}

/**
 * Recompute which of a person's ACTIVE leads is the primary caller. All active
 * leads stay CRM-visible; only the latest-activated is is_primary_caller (the
 * one that gets call-tracked). If the primary shifts, append a
 * primary_caller_shifted event on the new primary and update persons.
 */
export async function recomputePrimaryCaller(personId: string): Promise<string | null> {
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const active = (await leads.find({ person_id: personId, is_active: true } as any).toArray()) as any[];
  if (!active.length) {
    await (await getCrmCollection(COL.PERSONS)).updateOne(
      { _id: personId } as any,
      { $set: { active_lead_ids: [], primary_caller_lead_id: null, updated_at: nowISO() } },
      { upsert: false },
    );
    return null;
  }
  active.sort(comparePrimary);
  const primary = active[0];
  const prevPrimary = active.find((l) => l.is_primary_caller);

  for (const l of active) {
    const shouldBe = l._id === primary._id;
    if (!!l.is_primary_caller !== shouldBe || !!l.is_primary !== shouldBe) {
      await leads.updateOne(
        { _id: l._id } as any,
        { $set: { is_primary_caller: shouldBe, is_primary: shouldBe, updated_at: nowISO() } },
        { upsert: false },
      );
    }
  }

  await (await getCrmCollection(COL.PERSONS)).updateOne(
    { _id: personId } as any,
    {
      $set: {
        active_lead_ids: active.map((l) => l._id),
        primary_caller_lead_id: primary._id,
        updated_at: nowISO(),
      },
    },
    { upsert: false },
  );

  if (!prevPrimary || prevPrimary._id !== primary._id) {
    await appendEvent({
      lead_id: primary._id,
      person_id: personId,
      project: primary.project,
      type: "primary_caller_shifted",
      actor: "system",
      channel: "crm",
      reason: prevPrimary
        ? `primary caller shifted ${prevPrimary._id} → ${primary._id} (latest-activated)`
        : `primary caller set → ${primary._id}`,
      data: { from: prevPrimary?._id ?? null, to: primary._id },
    });
  }
  return primary._id;
}

// ─── ingest → new model (the main entry from ingestLead) ───────────────────

export interface IngestModelInput {
  phone: string;
  project?: string;
  source?: string;              // website / meta / inncircles / …
  name?: string;
  email?: string;
  language?: string;
  born_at?: string;             // when lead born at source (ISO / YYYY-MM-DD)
  inncircles_born_date?: string;
  source_lead_id?: string;
  flags?: ActivationFlags;      // the 4 Inncircles activation flags
  zoho_lead_id?: string | null;
  prefs?: Record<string, any>;
  activated_at?: string;        // defaults to now
}

export interface IngestModelResult {
  person_id: string;
  lead_id: string;
  target: "crm_leads" | "stale_person_record";
  activation_type: ActivationType | null;
  is_active: boolean;
  created: boolean;
  is_primary_caller: boolean;
}

/**
 * Populate the new event-sourced model for a freshly-ingested lead. Mongo-first
 * and additive — safe to call alongside the legacy ingest write. Idempotent:
 * re-ingesting the same (phone, project) does NOT duplicate lead_created /
 * activation events (they fire only on genuine creation / change).
 *
 * Flow:
 *   1. upsert person
 *   2. classify activation from the 4 flags
 *   3. active  → ensure crm_leads doc, append lead_created (on create) +
 *                activation (on create/change), recompute primary caller.
 *      stale   → ensure stale_person_record doc, append lead_created (on
 *                create). No activation event (all flags false).
 *   4. promotion: an activation flag arriving for a previously-stale lead
 *      moves it stale → crm_leads (event: activation, reason "promotion").
 */
export async function recordIngestToNewModel(input: IngestModelInput): Promise<IngestModelResult> {
  const personId = personIdOf(input.phone);
  if (!personId) throw new Error("recordIngestToNewModel: empty phone");
  const project = normProject(input.project);
  const leadId = leadIdOf(personId, project);
  const now = input.activated_at || nowISO();

  await upsertPerson({
    phone: input.phone,
    name: input.name,
    email: input.email,
    language: input.language,
    prefs: input.prefs,
    project,
  });

  const cls = classifyActivation(input.flags);
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const stale = await getCrmCollection(COL.STALE_PERSON_RECORD);

  // Current state of this lead across both collections.
  const existingActive = (await leads.findOne({ _id: leadId } as any)) as any;
  const existingStale = (await stale.findOne({ _id: leadId } as any)) as any;

  // ── ACTIVE path ───────────────────────────────────────────────────────
  if (cls.active) {
    let created = false;
    const promotedFromStale = !existingActive && !!existingStale;

    if (!existingActive) {
      // Insert the current-state doc (idempotent via $setOnInsert).
      const initial: any = {
        _id: leadId,
        person_id: personId,
        project,
        source: input.source ?? "",
        born_at: input.born_at ?? now,
        inncircles_born_date: input.inncircles_born_date ?? null,
        is_born_fresh: cls.flags.is_born_fresh,
        is_reactivated: cls.flags.is_reactivated,
        is_born_in_other_project: cls.flags.is_born_in_other_project,
        is_bulk_transfer: cls.flags.is_bulk_transfer,
        source_lead_id: input.source_lead_id ?? "",
        activation_type: cls.activation_type,
        is_active: true,
        is_primary_caller: false, // set by recomputePrimaryCaller below
        is_primary: false,
        activated_at: now,
        stage: "new",
        status: "never_contacted",
        is_terminal: false,
        // Terminal reason (§14.6) + captured primary interest (§19.11). Slots
        // exist from creation so the orchestrator context always has a field to
        // read even before capture is wired (set by changeStage / setPrimaryInterest).
        not_interested_reason: null,
        primary_interest: null,
        next_action_at: null,
        next_action_type: null,
        owner: null,
        counters: { call_count: 0, connected_count: 0, wa_in: 0, wa_out: 0, docs_sent: 0 },
        last: {},
        event_seq: 0,
        external: { zoho_lead_id: input.zoho_lead_id ?? null, synced: !!input.zoho_lead_id },
        created_at: now,
        updated_at: now,
      };
      const before = await leads.findOneAndUpdate(
        { _id: leadId } as any,
        { $setOnInsert: initial },
        { upsert: true, returnDocument: "before" },
      );
      created = !before;
    }

    // If promoted from stale, drop the stale record (history stays in events).
    if (promotedFromStale) {
      await stale.deleteOne({ _id: leadId } as any);
      // carry forward a previously-known stage if the stale doc had one
      if (existingStale?.last_stage && existingStale.last_stage !== "new") {
        await leads.updateOne(
          { _id: leadId } as any,
          { $set: { stage: existingStale.last_stage, is_terminal: isTerminalStage(existingStale.last_stage), updated_at: nowISO() } },
          { upsert: false },
        );
      }
    }

    if (created) {
      const ev = await appendEvent({
        lead_id: leadId, person_id: personId, project,
        type: "lead_created", actor: "system", channel: "crm",
        to: { stage: "new", status: "never_contacted" },
        reason: `lead created via ${input.source || "ingest"}`,
        data: { source: input.source ?? null, source_lead_id: input.source_lead_id ?? null },
      });
      await projectLead(leadId, ev.seq, {});
    }

    // Activation event fires on genuine create/promotion/type-change only.
    const activationChanged =
      created || promotedFromStale ||
      (existingActive && (existingActive.is_active !== true || existingActive.activation_type !== cls.activation_type));

    if (activationChanged) {
      const ev = await appendEvent({
        lead_id: leadId, person_id: personId, project,
        type: "activation", actor: "system", channel: "crm",
        reason: promotedFromStale
          ? `promoted from stale → active (${cls.activation_type})`
          : `activated (${cls.activation_type})`,
        data: { activation_type: cls.activation_type, flags: cls.flags, promoted: promotedFromStale },
      });
      await projectLead(leadId, ev.seq, {
        is_active: true,
        activation_type: cls.activation_type,
        is_born_fresh: cls.flags.is_born_fresh,
        is_reactivated: cls.flags.is_reactivated,
        is_born_in_other_project: cls.flags.is_born_in_other_project,
        is_bulk_transfer: cls.flags.is_bulk_transfer,
        activated_at: now,
        ...(input.zoho_lead_id ? { "external.zoho_lead_id": input.zoho_lead_id, "external.synced": true } : {}),
      });
    } else if (input.zoho_lead_id && existingActive && !existingActive.external?.zoho_lead_id) {
      // no activation change, but attach a newly-known zoho id
      await leads.updateOne(
        { _id: leadId } as any,
        { $set: { "external.zoho_lead_id": input.zoho_lead_id, "external.synced": true, updated_at: nowISO() } },
        { upsert: false },
      );
    }

    const primaryId = await recomputePrimaryCaller(personId);

    return {
      person_id: personId, lead_id: leadId, target: "crm_leads",
      activation_type: cls.activation_type, is_active: true,
      created, is_primary_caller: primaryId === leadId,
    };
  }

  // ── STALE path (all four flags explicitly false) ────────────────────────
  // If the lead is already active, an all-false re-push does NOT demote it
  // (Inncircles never demotes; only call-track shifts). Leave it be.
  if (existingActive) {
    return {
      person_id: personId, lead_id: leadId, target: "crm_leads",
      activation_type: existingActive.activation_type ?? null,
      is_active: true, created: false,
      is_primary_caller: !!existingActive.is_primary_caller,
    };
  }

  let created = false;
  if (!existingStale) {
    const initial: any = {
      _id: leadId,
      person_id: personId,
      project,
      source: input.source ?? "",
      inncircles_born_date: input.inncircles_born_date ?? null,
      flags: cls.flags,
      activation_type: null,
      stale_reason: cls.stale_reason,
      last_stage: null,
      event_seq: 0,
      external: { zoho_lead_id: input.zoho_lead_id ?? null, synced: !!input.zoho_lead_id },
      created_at: now,
      updated_at: now,
    };
    const before = await stale.findOneAndUpdate(
      { _id: leadId } as any,
      { $setOnInsert: initial },
      { upsert: true, returnDocument: "before" },
    );
    created = !before;
  }

  if (created) {
    await appendEvent({
      lead_id: leadId, person_id: personId, project,
      type: "lead_created", actor: "system", channel: "crm",
      to: { stage: "new" },
      reason: `not-interested sibling captured (stale) via ${input.source || "ingest"}`,
      data: { source: input.source ?? null, stale_reason: cls.stale_reason, flags: cls.flags },
    });
    // stale docs are not projected into crm_leads; bump event_seq on the stale doc
    await stale.updateOne(
      { _id: leadId } as any,
      { $set: { event_seq: 1, updated_at: nowISO() } },
      { upsert: false },
    );
  }

  return {
    person_id: personId, lead_id: leadId, target: "stale_person_record",
    activation_type: null, is_active: false, created,
    is_primary_caller: false,
  };
}

/** Attach a Zoho lead id to a crm_leads (or stale) doc after the fact. */
export async function setLeadZohoId(leadId: string, zohoLeadId: string): Promise<void> {
  if (!leadId || !zohoLeadId) return;
  const patch = { $set: { "external.zoho_lead_id": zohoLeadId, "external.synced": true, updated_at: nowISO() } };
  await (await getCrmCollection(COL.CRM_LEADS)).updateOne({ _id: leadId } as any, patch, { upsert: false });
  await (await getCrmCollection(COL.STALE_PERSON_RECORD)).updateOne({ _id: leadId } as any, patch, { upsert: false });
}

// ─── stage / status transitions (every change = one event) ─────────────────

export interface TransitionOpts {
  actor?: Actor;
  channel?: Channel;
  reason?: string;
  /** Set on a terminal transition (not_interested / lost / …). Stored on
   *  crm_leads.not_interested_reason so every terminal lead shows WHY it
   *  stopped (§14.6), and surfaced in the orchestrator context's
   *  not_interested[]. Also carried in the stage_change event's `reason`. */
  not_interested_reason?: string;
}

/** Move a lead to a new stage. No-op (returns changed:false) if already there.
 *  Appends a stage_change event, then projects stage + is_terminal + last. */
export async function changeStage(
  leadId: string,
  toStage: Stage,
  opts: TransitionOpts = {},
): Promise<{ changed: boolean; from?: string }> {
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const cur = (await leads.findOne({ _id: leadId } as any)) as any;
  if (!cur) return { changed: false };
  if (cur.stage === toStage) return { changed: false, from: cur.stage };

  const terminal = isTerminalStage(toStage);
  const ev = await appendEvent({
    lead_id: leadId, person_id: cur.person_id, project: cur.project,
    type: "stage_change", actor: opts.actor ?? "system", channel: opts.channel ?? "crm",
    from: { stage: cur.stage, status: cur.status },
    to: { stage: toStage },
    // On a terminal move, prefer the explicit not_interested_reason so history
    // carries WHY (§14.6); otherwise the caller-supplied reason.
    reason: (terminal && opts.not_interested_reason) || opts.reason,
  });

  await projectLead(leadId, ev.seq, {
    stage: toStage,
    is_terminal: terminal,
    "last.stage_changed_at": ev.ts,
    // Store the reason on the current-state doc for the one-view + context.
    // NOTE: is_active is deliberately NOT flipped here — it tracks Inncircles
    // activation, not stage (§3.8 keeps stale vs terminal distinct). The
    // orchestrator context partitions active leads by stage instead.
    ...(terminal && opts.not_interested_reason ? { not_interested_reason: opts.not_interested_reason } : {}),
    ...(terminal ? { next_action_at: null, next_action_type: null } : {}),
  });
  return { changed: true, from: cur.stage };
}

/** Move a lead's reachability status. No-op if unchanged. */
export async function changeStatus(
  leadId: string,
  toStatus: Status,
  opts: TransitionOpts = {},
): Promise<{ changed: boolean; from?: string }> {
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const cur = (await leads.findOne({ _id: leadId } as any)) as any;
  if (!cur) return { changed: false };
  if (cur.status === toStatus) return { changed: false, from: cur.status };

  const ev = await appendEvent({
    lead_id: leadId, person_id: cur.person_id, project: cur.project,
    type: "status_change", actor: opts.actor ?? "system", channel: opts.channel ?? "crm",
    from: { stage: cur.stage, status: cur.status },
    to: { status: toStatus },
    reason: opts.reason,
  });
  await projectLead(leadId, ev.seq, { status: toStatus });
  return { changed: true, from: cur.status };
}

/** Schedule the next action (the timer). null clears it. */
export async function scheduleNextAction(
  leadId: string,
  at: Date | string | null,
  type: "call" | "whatsapp" | null,
  opts: TransitionOpts = {},
): Promise<void> {
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const cur = (await leads.findOne({ _id: leadId } as any)) as any;
  if (!cur) return;
  const atISO = at ? new Date(at).toISOString() : null;
  const ev = await appendEvent({
    lead_id: leadId, person_id: cur.person_id, project: cur.project,
    type: "system", actor: opts.actor ?? "cron", channel: opts.channel ?? "system",
    reason: opts.reason ?? (atISO ? `next ${type} scheduled` : "next action cleared"),
    data: { next_action_at: atISO, next_action_type: type },
  });
  await projectLead(leadId, ev.seq, { next_action_at: atISO, next_action_type: type });
}

// ─── calls ─────────────────────────────────────────────────────────────────

export interface CallScheduledInput {
  call_id: string;
  lead_id: string;
  person_id: string;
  project: string;
  phone: string;
  scheduled_at?: string;
  provider?: "plivo" | "telnyx" | (string & {});
  actor?: Actor;
  /** Layer-1 snapshot (§16): the COMPACT orchestrator context the bot got for
   *  THIS dial. Persisted into the call_scheduled event's data.context_snapshot
   *  so the timeline shows "what the bot knew when it called". Optional +
   *  backward-compatible — usually the value returned by storeOrchestratorContext. */
  context_snapshot?: OrchestratorContextSnapshot | Record<string, any>;
}

/** Record a scheduled/triggered dial: writes the calls doc + call_scheduled
 *  event + bumps call_count. */
export async function recordCallScheduled(input: CallScheduledInput): Promise<void> {
  const calls = await getCrmCollection(COL.CALLS);
  const now = nowISO();
  await calls.updateOne(
    { _id: input.call_id } as any,
    {
      $setOnInsert: { _id: input.call_id, created_at: now },
      $set: {
        lead_id: input.lead_id, person_id: input.person_id, project: input.project,
        phone: digits(input.phone), scheduled_at: input.scheduled_at ?? now,
        provider: input.provider ?? "plivo", updated_at: now,
      },
    },
    { upsert: true },
  );
  // Idempotent per call_id: a retry must not re-append or double-count call_count.
  if (await eventExistsByRef(input.lead_id, "call_scheduled", input.call_id)) return;
  const ev = await appendEvent({
    lead_id: input.lead_id, person_id: input.person_id, project: input.project,
    type: "call_scheduled", actor: input.actor ?? "cron", channel: "call",
    ref: input.call_id,
    data: {
      provider: input.provider ?? "plivo",
      ...(input.context_snapshot ? { context_snapshot: input.context_snapshot } : {}),
    },
  });
  await projectLead(input.lead_id, ev.seq, { "last.call_at": ev.ts }, { "counters.call_count": 1 });
}

export interface CallCompletedInput {
  call_id: string;
  lead_id: string;
  person_id: string;
  project: string;
  outcome: "connected" | "no_answer" | "busy" | "switched_off" | "failed" | (string & {});
  /** semantic bot result — kept SEPARATE from `outcome` (the pre_site lesson). */
  disposition?: "pre_site" | "virtual_tour" | "callback" | "not_interested" | "info" | (string & {});
  dialed_at?: string;
  duration_secs?: number;
  recording_url?: string;
  transcript?: string;
  slots?: Record<string, any>; // { visit_date, callback_time }
  actor?: Actor;
}

/** Record a completed call: updates the calls doc + call_completed event +
 *  bumps connected_count when connected. Disposition stays in its own field. */
export async function recordCallCompleted(input: CallCompletedInput): Promise<void> {
  const calls = await getCrmCollection(COL.CALLS);
  const now = nowISO();
  await calls.updateOne(
    { _id: input.call_id } as any,
    {
      $setOnInsert: {
        _id: input.call_id, lead_id: input.lead_id, person_id: input.person_id,
        project: input.project, created_at: now,
      },
      $set: {
        outcome: input.outcome,
        disposition: input.disposition ?? null,
        dialed_at: input.dialed_at ?? now,
        duration_secs: input.duration_secs ?? null,
        recording_url: input.recording_url ?? null,
        transcript: input.transcript ?? null,
        slots: input.slots ?? null,
        updated_at: now,
      },
    },
    { upsert: true },
  );
  // Idempotent per call_id: a webhook retry must not re-append call_completed or
  // double-count connected_count.
  if (await eventExistsByRef(input.lead_id, "call_completed", input.call_id)) return;
  const connected = input.outcome === "connected";
  const ev = await appendEvent({
    lead_id: input.lead_id, person_id: input.person_id, project: input.project,
    type: "call_completed", actor: input.actor ?? "bot", channel: "call",
    ref: input.call_id,
    reason: `call ${input.outcome}${input.disposition ? ` · disposition ${input.disposition}` : ""}`,
    data: {
      outcome: input.outcome, disposition: input.disposition ?? null,
      duration_secs: input.duration_secs ?? null, slots: input.slots ?? null,
    },
  });
  await projectLead(
    input.lead_id, ev.seq,
    { "last.call_at": ev.ts, "last.call_outcome": input.outcome },
    connected ? { "counters.connected_count": 1 } : undefined,
  );
  // Advance reachability status off never_contacted once we actually connect.
  // changeStatus is itself a no-op when unchanged, and never demotes a lead we
  // already reached (we only promote TO connected here). Non-connected outcomes
  // (attempting/unreachable) depend on cadence-level retry counts, not a single
  // dial, so we leave status untouched for them.
  if (connected) {
    await changeStatus(input.lead_id, "connected", {
      actor: input.actor ?? "bot", channel: "call", reason: `call connected`,
    });
  }
}

// ─── messages (WhatsApp) ────────────────────────────────────────────────────

export interface MessageInput {
  message_id: string;
  person_id: string;
  phone: string;
  direction: "inbound" | "outbound";
  body?: string;
  ts?: string;
  sender?: string;
  intent?: string;
  project?: string;
  doc_ref?: string;
  /** optional lead to attribute the wa_* event to (usually the primary lead) */
  lead_id?: string;
  actor?: Actor;
  /** Layer-1 snapshot (§16): the COMPACT orchestrator context the bot got for
   *  THIS message. Only meaningful for outbound sends; persisted into the
   *  wa_outbound event's data.context_snapshot. Optional + backward-compatible. */
  context_snapshot?: OrchestratorContextSnapshot | Record<string, any>;
}

/** Store a WhatsApp message (phone-level) + append a wa_inbound/wa_outbound
 *  event on the given lead (if any) and bump wa counters. Message store is
 *  deduped by provider message id. */
export async function recordMessage(input: MessageInput): Promise<void> {
  void ensureCrmIndexes();
  const messages = await getCrmCollection(COL.CRM_MESSAGES);
  const now = input.ts ? new Date(input.ts).toISOString() : nowISO();
  await messages.updateOne(
    { _id: input.message_id } as any,
    {
      $setOnInsert: { _id: input.message_id, created_at: nowISO() },
      $set: {
        person_id: input.person_id, phone: digits(input.phone),
        direction: input.direction, body: input.body ?? "", ts: now,
        sender: input.sender ?? null, intent: input.intent ?? null,
        project: input.project ? normProject(input.project) : null,
        doc_ref: input.doc_ref ?? null,
      },
    },
    { upsert: true },
  );

  if (!input.lead_id) return; // phone-level store only; no lead to attribute
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const cur = (await leads.findOne({ _id: input.lead_id } as any)) as any;
  if (!cur) return;
  const inbound = input.direction === "inbound";
  // Idempotent per message_id: a provider retry must not re-append the wa_* event
  // or double-count wa_in/wa_out (the message doc itself is already deduped by _id).
  if (await eventExistsByRef(input.lead_id, inbound ? "wa_inbound" : "wa_outbound", input.message_id)) return;
  const ev = await appendEvent({
    lead_id: input.lead_id, person_id: input.person_id, project: cur.project,
    type: inbound ? "wa_inbound" : "wa_outbound",
    actor: input.actor ?? (inbound ? "customer" : "bot"), channel: "whatsapp",
    ref: input.message_id,
    reason: input.intent ? `intent: ${input.intent}` : undefined,
    data: {
      intent: input.intent ?? null,
      doc_ref: input.doc_ref ?? null,
      // Layer-1 snapshot on the outbound touch only (inbound carries none).
      ...(!inbound && input.context_snapshot ? { context_snapshot: input.context_snapshot } : {}),
    },
  });
  await projectLead(
    input.lead_id, ev.seq,
    inbound ? { "last.inbound_at": ev.ts } : { "last.outbound_at": ev.ts },
    inbound ? { "counters.wa_in": 1 } : { "counters.wa_out": 1 },
  );
}

/** Record a document (PDF) sent over WhatsApp: doc_sent event + docs_sent++. */
export async function recordDocSent(
  leadId: string,
  docType: string,
  opts: { ref?: string; sizeLabel?: string; actor?: Actor } = {},
): Promise<void> {
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const cur = (await leads.findOne({ _id: leadId } as any)) as any;
  if (!cur) return;
  // Idempotent per ref (when the caller supplies one): a retry of the same send
  // must not re-append doc_sent or double-count docs_sent. With no ref we can't
  // tell a retry from a deliberate re-send, so the append proceeds.
  if (await eventExistsByRef(leadId, "doc_sent", opts.ref)) return;
  const ev = await appendEvent({
    lead_id: leadId, person_id: cur.person_id, project: cur.project,
    type: "doc_sent", actor: opts.actor ?? "bot", channel: "whatsapp",
    ref: opts.ref, reason: `sent ${docType}${opts.sizeLabel ? ` (${opts.sizeLabel})` : ""}`,
    data: { doc_type: docType, size_label: opts.sizeLabel ?? null },
  });
  await projectLead(leadId, ev.seq, {}, { "counters.docs_sent": 1 });
}

// ─── site visits ────────────────────────────────────────────────────────────

export interface SiteVisitInput {
  visit_id: string;
  lead_id: string;
  person_id: string;
  project: string;
  type?: "site" | "virtual";
  scheduled_for: string;
  booked_via?: "call" | "whatsapp" | "rm";
  actor?: Actor;
}

/** Book a site visit: writes the site_visits row (status booked) +
 *  visit_booked event. Does NOT change stage — callers pair it with
 *  changeStage("visit_scheduled") so the milestone/automation-stop is explicit. */
export async function recordSiteVisitBooked(input: SiteVisitInput): Promise<void> {
  const visits = await getCrmCollection(COL.SITE_VISITS);
  const now = nowISO();
  await visits.updateOne(
    { _id: input.visit_id } as any,
    {
      $setOnInsert: { _id: input.visit_id, created_at: now },
      $set: {
        lead_id: input.lead_id, person_id: input.person_id, project: input.project,
        type: input.type ?? "site", scheduled_for: new Date(input.scheduled_for).toISOString(),
        status: "booked", booked_via: input.booked_via ?? "call", updated_at: now,
      },
    },
    { upsert: true },
  );
  // Idempotent per visit_id: a retry must not re-append visit_booked.
  if (await eventExistsByRef(input.lead_id, "visit_booked", input.visit_id)) return;
  const ev = await appendEvent({
    lead_id: input.lead_id, person_id: input.person_id, project: input.project,
    type: "visit_booked", actor: input.actor ?? "bot", channel: input.booked_via === "whatsapp" ? "whatsapp" : "call",
    ref: input.visit_id, reason: `visit booked for ${input.scheduled_for}`,
    data: { scheduled_for: input.scheduled_for, type: input.type ?? "site" },
  });
  await projectLead(input.lead_id, ev.seq, { "last.visit_booked_at": ev.ts });
}

/** Mark a booked visit done / no_show / cancelled + visit_done event. */
export async function recordSiteVisitOutcome(
  visitId: string,
  status: "done" | "no_show" | "cancelled",
  opts: { actor?: Actor } = {},
): Promise<void> {
  const visits = await getCrmCollection(COL.SITE_VISITS);
  const visit = (await visits.findOne({ _id: visitId } as any)) as any;
  if (!visit) return;
  await visits.updateOne(
    { _id: visitId } as any,
    { $set: { status, updated_at: nowISO() } },
    { upsert: false },
  );
  const ev = await appendEvent({
    lead_id: visit.lead_id, person_id: visit.person_id, project: visit.project,
    type: "visit_done", actor: opts.actor ?? "rm", channel: "crm",
    ref: visitId, reason: `visit ${status}`,
    data: { status },
  });
  await projectLead(visit.lead_id, ev.seq, { "last.visit_outcome_at": ev.ts });
}

// ─── calling-agent cross-project context ───────────────────────────────────

export interface CallerContext {
  person_id: string;
  primary_caller_lead_id: string | null;
  current: { project: string; stage: string; activation_type: ActivationType | null } | null;
  other_active: Array<{ project: string; stage: string; activation_type: ActivationType | null }>;
  not_interested: Array<{ project: string }>;
  do_not_contact: boolean;
}

/**
 * Build the cross-project picture the orchestrator hands the calling agent when
 * it fires the primary caller: the current project+stage+activation_type, the
 * OTHER active projects (context/continuity), and the not-interested siblings
 * (so the agent doesn't re-pitch a project the person already declined).
 */
export async function buildCallerContext(phone: string): Promise<CallerContext> {
  const personId = personIdOf(phone);
  const persons = await getCrmCollection(COL.PERSONS);
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const stale = await getCrmCollection(COL.STALE_PERSON_RECORD);

  const person = (await persons.findOne({ _id: personId } as any)) as any;
  const active = (await leads.find({ person_id: personId, is_active: true } as any).toArray()) as any[];
  const staleRecs = (await stale.find({ person_id: personId } as any).toArray()) as any[];

  const primaryId = person?.primary_caller_lead_id ?? active.find((l) => l.is_primary_caller)?._id ?? null;
  const primary = active.find((l) => l._id === primaryId) || null;

  return {
    person_id: personId,
    primary_caller_lead_id: primaryId,
    current: primary
      ? { project: primary.project, stage: primary.stage, activation_type: primary.activation_type ?? null }
      : null,
    other_active: active
      .filter((l) => l._id !== primaryId)
      .map((l) => ({ project: l.project, stage: l.stage, activation_type: l.activation_type ?? null })),
    not_interested: staleRecs.map((s) => ({ project: s.project })),
    do_not_contact: !!person?.do_not_contact,
  };
}

// ─── Orchestrator context (§16 / §17) — the per-touch context layer ─────────
//
// The context orchestrator builds, for every outreach touch (a call or a
// WhatsApp send), the exact STATE it hands the bot. This is a strict superset
// of CallerContext (§6.3): it also carries prefs, identity, the last inbound
// reply, primary_interest, a recent call/message summary, multi-project flags,
// per-project not_interested_reason, and the RESOLVED decision.
//
// DESIGN (product-approved): the context stores person/lead STATE + prefs +
// decision and POINTS to the active projects BY NAME — it never copies
// KB/offer/inventory blobs (the bot loads those separately at reply time).
// Keeps snapshots lean and avoids stale KB copies.
//
// It is STORED in three layers (all kept — §16):
//   1. Timeline snapshot — a COMPACT context_snapshot on each call_scheduled /
//      wa_outbound lead_event (see recordCallScheduled / recordMessage).
//   2. orchestrator_context collection — one FULL doc per interaction + the
//      resolved decision, keyed { person_id, lead_id, interaction_id, ts }.
//   3. crm_leads.orchestrator_context — the LATEST built context (one-view).
//
// buildOrchestratorContext is READ-ONLY. storeOrchestratorContext performs the
// writes (layers 2 + 3) and returns the compact snapshot for layer 1.

export interface OrchestratorPrefs {
  budget_min: number | string | null;
  budget_max: number | string | null;
  size: string | null;
  config: string | null;
  facing: string | null;
  timeline: string | null;
  purpose: string | null;
}

export interface OrchestratorProject {
  project: string;
  stage: string;
  activation_type: ActivationType | null;
  is_primary_caller: boolean;
  flags: Required<ActivationFlags>;
}

export interface OrchestratorNotInterested {
  project: string;
  not_interested_reason: string | null;
  activation_type: ActivationType | null;
  /** terminal = an explicitly-declined active lead (stage not_interested/lost);
   *  stale = a not-interested Inncircles sibling in stale_person_record. */
  source: "terminal" | "stale";
}

export interface OrchestratorLastInbound {
  text: string;
  ts: string | null;
  intent: string | null;
  days_since: number | null;
}

export interface OrchestratorRecentSummary {
  call_count: number;
  connected_count: number;
  last_call_outcome: string | null;
  wa_in: number;
  wa_out: number;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

/** The resolved decision the orchestrator reached for this touch (which project
 *  is being worked, on which channel, when, and why). Owned by the cadence /
 *  reactive phases — Phase 2 just carries + stores it. */
export interface OrchestratorDecision {
  project: string | null;
  next_action_type: "call" | "whatsapp" | null;
  next_action_at: string | null;
  reason: string | null;
}

export interface OrchestratorContext {
  person_id: string;
  phone: string;
  name: string | null;
  language: string | null;
  do_not_contact: boolean;
  prefs: OrchestratorPrefs;
  primary_caller_lead_id: string | null;
  /** The project currently being worked (primary caller), null if none. */
  current: OrchestratorProject | null;
  /** Other live projects for continuity (never re-pitch a declined one). */
  other_active: OrchestratorProject[];
  /** Declined projects WITH reason: terminal active leads + stale siblings. */
  not_interested: OrchestratorNotInterested[];
  is_multi_project: boolean;
  active_project_count: number;
  last_inbound: OrchestratorLastInbound | null;
  /** Captured customer primary interest (§19.11) — drives focus once set. */
  primary_interest: string | null;
  recent: OrchestratorRecentSummary;
  /** Human-readable recent-chat summary. Populated ONLY when the caller passes
   *  includeConversationSummary; reads the LEGACY Zoho_Database whatsapp_messages
   *  (read-only — NOT a write into the legacy DB). Left null by default so the
   *  stored snapshot stays new-model-only. */
  conversation_summary: string | null;
  decision: OrchestratorDecision | null;
  built_at: string;
}

/** The COMPACT projection embedded in the touch event (Layer 1). Kept small and
 *  with the raw last-inbound text truncated, because it lands in the immutable,
 *  never-TTL'd lead_events timeline (PII-sprawl guard, §19.5). */
export interface OrchestratorContextSnapshot {
  person_id: string;
  current: { project: string; stage: string; activation_type: ActivationType | null } | null;
  other_active: Array<{ project: string; stage: string }>;
  not_interested: Array<{ project: string; not_interested_reason: string | null }>;
  prefs: { budget_min: number | string | null; budget_max: number | string | null; size: string | null };
  primary_interest: string | null;
  last_inbound: { intent: string | null; days_since: number | null; text: string } | null;
  is_multi_project: boolean;
  active_project_count: number;
  do_not_contact: boolean;
  decision: OrchestratorDecision | null;
  built_at: string;
}

function leadToProject(l: any, primaryId: string | null): OrchestratorProject {
  return {
    project: l.project,
    stage: l.stage,
    activation_type: l.activation_type ?? null,
    is_primary_caller: l._id === primaryId,
    flags: {
      is_born_fresh: !!l.is_born_fresh,
      is_reactivated: !!l.is_reactivated,
      is_born_in_other_project: !!l.is_born_in_other_project,
      is_bulk_transfer: !!l.is_bulk_transfer,
    },
  };
}

/** True for the two "declined" terminal stages that belong in not_interested[]
 *  (booked/spam are terminal too but are NOT declines). */
function isDeclinedStage(stage?: string | null): boolean {
  return stage === "not_interested" || stage === "lost";
}

/**
 * Build the full orchestrator context for a person (READ-ONLY — no writes).
 *
 * Reads persons + crm_leads (active) + stale_person_record + Intelligent_CRM
 * messages (last inbound). Partitions active leads BY STAGE (not by is_active
 * alone): a cadence-terminal not_interested/lost lead keeps is_active:true
 * (§3.8), so relying on is_active would leak a declined project into
 * other_active — instead declined active leads go into not_interested[] WITH
 * their not_interested_reason, and stale siblings are a separate source.
 *
 * POINTS to projects by name only — no KB/inventory copied.
 */
export async function buildOrchestratorContext(
  phone: string,
  opts: { decision?: OrchestratorDecision; includeConversationSummary?: boolean } = {},
): Promise<OrchestratorContext> {
  const personId = personIdOf(phone);
  const persons = await getCrmCollection(COL.PERSONS);
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const stale = await getCrmCollection(COL.STALE_PERSON_RECORD);
  const messages = await getCrmCollection(COL.CRM_MESSAGES);

  const person = (await persons.findOne({ _id: personId } as any)) as any;
  const active = (await leads.find({ person_id: personId, is_active: true } as any).toArray()) as any[];
  const staleRecs = (await stale.find({ person_id: personId } as any).toArray()) as any[];

  // Partition active leads by stage (see doc above).
  const declined = active.filter((l) => isDeclinedStage(l.stage));
  const workable = active.filter((l) => !isDeclinedStage(l.stage));

  const primaryId =
    person?.primary_caller_lead_id ?? workable.find((l) => l.is_primary_caller)?._id ?? null;
  const primary = workable.find((l) => l._id === primaryId) || null;

  const not_interested: OrchestratorNotInterested[] = [
    ...declined.map((l) => ({
      project: l.project,
      not_interested_reason: l.not_interested_reason ?? null,
      activation_type: (l.activation_type ?? null) as ActivationType | null,
      source: "terminal" as const,
    })),
    ...staleRecs.map((s) => ({
      project: s.project,
      not_interested_reason: s.not_interested_reason ?? s.stale_reason ?? null,
      activation_type: null,
      source: "stale" as const,
    })),
  ];

  // Last inbound from the NEW-model messages (index idx_msg_person_ts). We do
  // NOT reuse getConversationContext for this because it reads the legacy
  // Zoho_Database — the stored snapshot must stay Intelligent_CRM-only.
  let last_inbound: OrchestratorLastInbound | null = null;
  try {
    const lastIn = (await messages.findOne(
      { person_id: personId, direction: "inbound" } as any,
      { sort: { ts: -1 } as any },
    )) as any;
    if (lastIn) {
      const tsIso: string | null = lastIn.ts ?? lastIn.created_at ?? null;
      const daysSince =
        tsIso && ts(tsIso) !== -Infinity
          ? Math.floor((Date.now() - new Date(tsIso).getTime()) / 86400000)
          : null;
      last_inbound = {
        text: String(lastIn.body ?? "").slice(0, 500),
        ts: tsIso,
        intent: lastIn.intent ?? null,
        days_since: daysSince,
      };
    }
  } catch (err: any) {
    console.error(`[crm_model] buildOrchestratorContext last_inbound failed: ${err.message}`);
  }

  const counters = (primary?.counters ?? {}) as any;
  const last = (primary?.last ?? {}) as any;
  const prefs = (person?.prefs ?? {}) as any;

  const activeCount = Array.isArray(person?.active_lead_ids)
    ? person.active_lead_ids.length
    : active.length;

  // Optional human-readable summary (legacy read — see field doc).
  let conversation_summary: string | null = null;
  if (opts.includeConversationSummary) {
    try {
      const conv = await getConversationContext(phone);
      conversation_summary = conv.formatted;
    } catch (err: any) {
      console.error(`[crm_model] buildOrchestratorContext conv summary failed: ${err.message}`);
    }
  }

  return {
    person_id: personId,
    phone: digits(phone) || personId,
    name: person?.name ?? null,
    language: person?.language ?? null,
    do_not_contact: !!person?.do_not_contact,
    prefs: {
      budget_min: prefs.budget_min ?? null,
      budget_max: prefs.budget_max ?? null,
      size: prefs.size ?? null,
      config: prefs.config ?? null,
      facing: prefs.facing ?? null,
      timeline: prefs.timeline ?? null,
      purpose: prefs.purpose ?? null,
    },
    primary_caller_lead_id: primaryId,
    current: primary ? leadToProject(primary, primaryId) : null,
    other_active: workable
      .filter((l) => l._id !== primaryId)
      .map((l) => leadToProject(l, primaryId)),
    not_interested,
    is_multi_project: activeCount > 1,
    active_project_count: activeCount,
    last_inbound,
    primary_interest:
      primary?.primary_interest ?? workable.find((l) => l.primary_interest)?.primary_interest ?? null,
    recent: {
      call_count: counters.call_count ?? 0,
      connected_count: counters.connected_count ?? 0,
      last_call_outcome: last.call_outcome ?? null,
      wa_in: counters.wa_in ?? 0,
      wa_out: counters.wa_out ?? 0,
      last_inbound_at: last.inbound_at ?? null,
      last_outbound_at: last.outbound_at ?? null,
    },
    conversation_summary,
    decision: opts.decision ?? null,
    built_at: nowISO(),
  };
}

/** Compact a full context down to the Layer-1 event snapshot (truncates the raw
 *  last-inbound text — it lands in the permanent, never-deleted timeline). */
export function compactSnapshot(ctx: OrchestratorContext): OrchestratorContextSnapshot {
  return {
    person_id: ctx.person_id,
    current: ctx.current
      ? { project: ctx.current.project, stage: ctx.current.stage, activation_type: ctx.current.activation_type }
      : null,
    other_active: ctx.other_active.map((p) => ({ project: p.project, stage: p.stage })),
    not_interested: ctx.not_interested.map((n) => ({
      project: n.project,
      // Truncated: this lands in the permanent, never-deleted Layer-1 timeline —
      // keep free-text reasons bounded so a long future reason can't bloat every event.
      not_interested_reason: n.not_interested_reason == null ? n.not_interested_reason : String(n.not_interested_reason).slice(0, 120),
    })),
    prefs: { budget_min: ctx.prefs.budget_min, budget_max: ctx.prefs.budget_max, size: ctx.prefs.size },
    primary_interest: ctx.primary_interest,
    last_inbound: ctx.last_inbound
      ? {
          intent: ctx.last_inbound.intent,
          days_since: ctx.last_inbound.days_since,
          text: String(ctx.last_inbound.text ?? "").slice(0, 120),
        }
      : null,
    is_multi_project: ctx.is_multi_project,
    active_project_count: ctx.active_project_count,
    do_not_contact: ctx.do_not_contact,
    decision: ctx.decision ?? null,
    built_at: ctx.built_at,
  };
}

export interface StoreOrchestratorContextOpts {
  /** Stable id for THIS touch — dedupes a retried store (no double doc/event). */
  interaction_id: string;
  /** The lead being worked (its crm_leads doc caches the latest context). */
  lead_id: string;
  touch_type: "call" | "whatsapp";
  person_id?: string;
  ts?: string;
  /** The resolved decision to embed in the stored context. Falls back to
   *  ctx.decision if omitted. */
  decision?: OrchestratorDecision;
}

/**
 * Store the built context across §16's three layers and return the compact
 * snapshot for the emitting event (Layer 1). Idempotent + golden-rule safe:
 *   • Layer 2: upserts ONE orchestrator_context doc keyed by interaction_id
 *     (== _id) via $setOnInsert — a retry does NOT create a second doc.
 *   • Layer 3: $sets crm_leads.orchestrator_context = the latest context.
 *   • Returns compactSnapshot(ctx) so the caller can pass it as
 *     context_snapshot into recordCallScheduled / recordMessage (Layer 1).
 *
 * Does NOT append any event itself — the touch event (call_scheduled /
 * wa_outbound) carries the Layer-1 snapshot and stays the single source of the
 * counter $inc, avoiding a double-count on retry.
 */
export async function storeOrchestratorContext(
  ctx: OrchestratorContext,
  opts: StoreOrchestratorContextOpts,
): Promise<OrchestratorContextSnapshot> {
  if (!opts.interaction_id) throw new Error("storeOrchestratorContext: empty interaction_id");
  void ensureCrmIndexes();

  const interactionId = opts.interaction_id;
  const leadId = opts.lead_id;
  const personId = opts.person_id || ctx.person_id;
  const tsIso = opts.ts ? new Date(opts.ts).toISOString() : nowISO();
  const decision = opts.decision ?? ctx.decision ?? null;
  const fullCtx: OrchestratorContext = { ...ctx, decision };

  // Layer 2 — dedicated collection, idempotent by interaction_id (== _id).
  const col = await getCrmCollection(COL.ORCHESTRATOR_CONTEXT);
  try {
    await col.updateOne(
      { _id: interactionId } as any,
      {
        $setOnInsert: {
          _id: interactionId,
          interaction_id: interactionId,
          person_id: personId,
          lead_id: leadId,
          touch_type: opts.touch_type,
          ts: tsIso,
          context: fullCtx,
          decision,
          created_at: nowISO(),
        },
      },
      { upsert: true },
    );
  } catch (err: any) {
    // Two truly-concurrent stores with the same interaction_id can both miss the
    // upsert and race to insert; the loser hits E11000. The doc already exists
    // (dedupe held), so a duplicate-key is the intended idempotent no-op — swallow
    // it. Anything else is a real error and rethrows.
    if (err?.code !== 11000) throw err;
  }

  // Layer 3 — cache the latest built context on the lead for the one-view.
  if (leadId) {
    const leads = await getCrmCollection(COL.CRM_LEADS);
    await leads.updateOne(
      { _id: leadId } as any,
      {
        $set: {
          orchestrator_context: {
            ...fullCtx,
            interaction_id: interactionId,
            touch_type: opts.touch_type,
            ts: tsIso,
          },
          updated_at: nowISO(),
        },
      },
      { upsert: false },
    );
  }

  // Layer 1 — the caller embeds this into the touch event.
  return compactSnapshot(fullCtx);
}

/**
 * Capture the customer's primary interest (§19.11): sets crm_leads.primary_interest
 * and appends a note event. The posthook / reactive-bot phase calls this after
 * the bot asks "which project are you most interested in". No-op if unchanged.
 * (Focus/call-track shifting to that project is the cadence phase's job.)
 */
export async function setPrimaryInterest(
  leadId: string,
  project: string,
  opts: TransitionOpts = {},
): Promise<{ changed: boolean }> {
  const leads = await getCrmCollection(COL.CRM_LEADS);
  const cur = (await leads.findOne({ _id: leadId } as any)) as any;
  if (!cur) return { changed: false };
  const norm = normProject(project);
  if (cur.primary_interest === norm) return { changed: false };

  const ev = await appendEvent({
    lead_id: leadId, person_id: cur.person_id, project: cur.project,
    type: "note", actor: opts.actor ?? "bot", channel: opts.channel ?? "crm",
    reason: opts.reason ?? `primary interest captured → ${norm}`,
    data: { primary_interest: norm },
  });
  await projectLead(leadId, ev.seq, { primary_interest: norm });
  return { changed: true };
}
