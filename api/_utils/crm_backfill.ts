/**
 * crm_backfill.ts — migrate the legacy flat `leads` mirror into the new
 * event-sourced model (persons / crm_leads / lead_events / stale_person_record).
 *
 * DRY-RUN BY DEFAULT. Nothing is written unless `commit: true` is passed
 * explicitly. In dry-run it only READS the legacy `leads` collection + the new
 * collections (to tell "would create" from "already present"), tallies what it
 * WOULD do, and returns a small sample — never a single write.
 *
 * Missing / old fields are skipped gracefully: a legacy doc with no phone is
 * counted in `skipped_no_phone`; absent flags fall through classifyActivation
 * as a normal fresh active lead; an unmappable stage stays `new`.
 *
 * Idempotent on commit: recordIngestToNewModel only emits lead_created /
 * activation events on genuine creation/change, and changeStage no-ops when the
 * stage already matches — so re-running commit does not double-write history.
 */

import { getCollection, getCrmCollection, COL } from "./mongo";
import {
  recordIngestToNewModel,
  changeStage,
  personIdOf,
  leadIdOf,
  classifyActivation,
  type Stage,
  type ActivationFlags,
} from "./crm_model";

// ─── legacy stage → new stage enum ─────────────────────────────────────────

/** Map the legacy PRD_Stage / Lead_Status vocabulary onto the new clean enum.
 *  Lead_Status (richer) is tried first, then PRD_Stage; default "new". */
export function mapLegacyStage(prdStage?: string | null, leadStatus?: string | null): Stage {
  const probe = (raw?: string | null): Stage | null => {
    const v = String(raw || "").trim().toLowerCase();
    if (!v) return null;
    if (/spam/.test(v)) return "spam";
    if (/not interested|not qualif|disqualif|lost|junk|dead/.test(v)) return "not_interested";
    if (/booked|won|customer|closed won/.test(v)) return "booked";
    if (/negotiat/.test(v)) return "negotiation";
    if (/post.?site|visit done|site visit done/.test(v)) return "visit_done";
    if (/pre.?site|site visit|virtual tour|visit sched|visit confirm/.test(v)) return "visit_scheduled";
    if (/qualif/.test(v)) return "qualified";
    if (/engaged|replied|connected|answered|intent/.test(v)) return "engaged";
    if (/contacted|lead initiated|attempt|first touch|in future/.test(v)) return "contacted";
    if (/fresh|^new|not contacted|uncontacted|new lead/.test(v)) return "new";
    return null;
  };
  return probe(leadStatus) ?? probe(prdStage) ?? "new";
}

/** Pull the 4 activation flags from a legacy leads doc (they were mirrored as
 *  top-level fields; may be null/undefined). Undefined-preserving so a legacy
 *  doc with no flag info classifies as a normal fresh active lead rather than
 *  being mistaken for an all-false stale sibling. */
function flagsFromLegacy(doc: any): ActivationFlags {
  const coerce = (v: any): boolean | undefined =>
    v === true || v === "true" || v === 1 || v === "1" ? true
    : v === false || v === "false" || v === 0 || v === "0" ? false
    : undefined;
  return {
    is_born_fresh: coerce(doc.is_born_fresh),
    is_reactivated: coerce(doc.is_reactivated),
    is_born_in_other_project: coerce(doc.is_born_in_other_project),
    is_bulk_transfer: coerce(doc.is_bulk_transfer),
  };
}

// ─── report shape ──────────────────────────────────────────────────────────

export interface BackfillReport {
  mode: "dry-run" | "commit";
  scanned: number;
  skipped_no_phone: number;
  persons: number;              // unique phones touched
  active_leads: number;         // would-create / created active crm_leads
  stale_leads: number;          // would-create / created stale records
  already_present: number;      // lead_id already existed (idempotent skip of creation)
  stage_sets: number;           // non-"new" stages applied / would-apply
  events_estimated: number;     // approximate lead_events that would be appended
  errors: string[];
  samples: Array<{
    phone: string;
    project: string;
    target: "crm_leads" | "stale_person_record";
    activation_type: string | null;
    stage: Stage;
    already_present: boolean;
  }>;
  ms: number;
  note: string;
}

export interface BackfillOpts {
  commit?: boolean;
  /** cap the number of legacy docs scanned (Vercel budget). default 500. */
  limit?: number;
}

/**
 * Run the migration. DRY-RUN unless opts.commit === true.
 *
 * Reads legacy COL.LEADS, and for each doc with a phone:
 *   • classifies activation from the mirrored flags
 *   • maps the legacy stage to the new enum
 *   • dry-run: tallies would-create vs already-present (reads only, NO WRITES)
 *   • commit: recordIngestToNewModel(...) then changeStage(mappedStage)
 */
export async function backfillNewModel(opts: BackfillOpts = {}): Promise<BackfillReport> {
  const t0 = Date.now();
  const commit = opts.commit === true;
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 20000));

  const legacy = await getCollection(COL.LEADS);              // legacy source — Zoho_Database
  const crmLeads = await getCrmCollection(COL.CRM_LEADS);     // new model — Intelligent_CRM
  const staleCol = await getCrmCollection(COL.STALE_PERSON_RECORD);

  const report: BackfillReport = {
    mode: commit ? "commit" : "dry-run",
    scanned: 0, skipped_no_phone: 0, persons: 0,
    active_leads: 0, stale_leads: 0, already_present: 0,
    stage_sets: 0, events_estimated: 0, errors: [],
    samples: [], ms: 0,
    note: commit
      ? "COMMIT mode — wrote to persons / crm_leads / lead_events / stale_person_record."
      : "DRY-RUN — no writes performed. Pass commit=true to apply.",
  };

  const persons = new Set<string>();
  const cursor = legacy.find({} as any).limit(limit);

  for await (const doc of cursor as any) {
    report.scanned++;
    const phone = String((doc as any).phone || "").replace(/\D/g, "");
    if (!phone) { report.skipped_no_phone++; continue; }

    try {
      const project = String((doc as any).project || "UNKNOWN");
      const personId = personIdOf(phone);
      const leadId = leadIdOf(personId, project);
      persons.add(personId);

      const flags = flagsFromLegacy(doc);
      const cls = classifyActivation(flags);
      const mappedStage = mapLegacyStage((doc as any).prd_stage, (doc as any).lead_status);

      // Does a new-model doc already exist for this lead?
      const [existActive, existStale] = await Promise.all([
        crmLeads.findOne({ _id: leadId } as any),
        staleCol.findOne({ _id: leadId } as any),
      ]);
      const alreadyPresent = !!existActive || !!existStale;

      const target: "crm_leads" | "stale_person_record" = cls.active ? "crm_leads" : "stale_person_record";

      if (report.samples.length < 20) {
        report.samples.push({
          phone, project: project.toUpperCase(), target,
          activation_type: cls.activation_type, stage: mappedStage, already_present: alreadyPresent,
        });
      }

      if (commit) {
        const r = await recordIngestToNewModel({
          phone,
          project,
          source: (doc as any).lead_source || (doc as any).source || "",
          name: `${(doc as any).first_name || ""} ${(doc as any).last_name || ""}`.trim(),
          email: (doc as any).email || undefined,
          born_at: (doc as any).born_date || (doc as any).created_time || (doc as any).lead_received_at || undefined,
          inncircles_born_date: (doc as any).inncircles_born_date || (doc as any).born_date || undefined,
          source_lead_id: (doc as any).source_lead_id || undefined,
          flags,
          zoho_lead_id: (doc as any).zoho_lead_id || null,
        });
        if (r.target === "crm_leads") report.active_leads++; else report.stale_leads++;
        if (r.created) {
          report.events_estimated += r.target === "crm_leads" ? 2 : 1; // created (+ activation)
        } else {
          report.already_present++;
        }
        // Apply the historical stage (idempotent; only active leads project a stage).
        if (r.target === "crm_leads" && mappedStage !== "new") {
          const sc = await changeStage(leadId, mappedStage, { actor: "system", reason: "backfill: imported legacy stage" });
          if (sc.changed) { report.stage_sets++; report.events_estimated++; }
        }
      } else {
        // DRY-RUN — tally only, NO WRITES.
        if (alreadyPresent) {
          report.already_present++;
        } else if (cls.active) {
          report.active_leads++;
          report.events_estimated += 2; // lead_created + activation
          if (mappedStage !== "new") { report.stage_sets++; report.events_estimated++; }
        } else {
          report.stale_leads++;
          report.events_estimated += 1; // lead_created
        }
      }
    } catch (err: any) {
      if (report.errors.length < 20) report.errors.push(`${phone}: ${err.message}`);
    }

    // Time-budget guard so we never blow the serverless cap on a big run.
    if (Date.now() - t0 > 240_000) {
      report.note += ` (stopped early at ${report.scanned} scanned — 240s time budget)`;
      break;
    }
  }

  report.persons = persons.size;
  report.ms = Date.now() - t0;
  return report;
}
