# ASBL CRM — Product Requirements Document (Rebuild v1)

**Audience:** an external engineer who has never seen this system and must build the
CRM back end exactly as specified here.
**Status:** approved architecture. This PRD is the buildable spec; the visual source
of design truth is `db_architecture.html` (event-sourced Mongo design). Where this
document and the HTML disagree on wording, the **behavior described here** wins,
because it reflects the reference write-layer already implemented in
`api/_utils/crm_model.ts`.

> Naming note: the reference implementation ships in the same repo but writes to a
> **parallel** set of collections (prefixed where a legacy name already exists) so it
> can coexist with the old system during migration. A greenfield build can use the
> "logical" collection names (`persons`, `leads`, `lead_events`, …). The physical
> names the current code uses are listed in §3.0.

---

## Table of contents

1. [Goal](#1-goal)
2. [Glossary](#2-glossary)
3. [Complete database architecture](#3-complete-database-architecture)
   - 3.0 [Collection name map](#30-collection-name-map)
   - 3.1 [Core idea: event log + projection](#31-core-idea-event-log--projection)
   - 3.2 [`persons`](#32-persons)
   - 3.3 [`leads` (current-state projection)](#33-leads-current-state-projection)
   - 3.4 [`lead_events` (append-only timeline)](#34-lead_events-append-only-timeline)
   - 3.5 [`calls`](#35-calls)
   - 3.6 [`messages`](#36-messages)
   - 3.7 [`site_visits`](#37-site_visits)
   - 3.8 [`stale_person_record`](#38-stale_person_record)
   - 3.9 [Support / config collections](#39-support--config-collections)
4. [The stage machine](#4-the-stage-machine)
5. [Worked example: a lead's full timeline](#5-worked-example-a-leads-full-timeline)
6. [Inncircles multi-project logic (full)](#6-inncircles-multi-project-logic-full)
7. [Indexing plan (full)](#7-indexing-plan-full)
8. [Data contracts the CRM UI needs](#8-data-contracts-the-crm-ui-needs)
9. [Ingestion → Mongo → CRM data flow](#9-ingestion--mongo--crm-data-flow)
10. [The golden write rule (every mutation)](#10-the-golden-write-rule-every-mutation)
11. [Migration / cutover plan](#11-migration--cutover-plan)
12. [Remaining gaps (honest status)](#12-remaining-gaps-honest-status)
13. [Reference implementation map](#13-reference-implementation-map)

---

## 1. Goal

**Zoho CRM is being discontinued. MongoDB becomes the single source of truth.**

Today Zoho is the "brain": leads live in Zoho, lifecycle state (stage/status) lives in
Zoho, and outbound automation (blueprint transitions, cadence) is driven off Zoho
fields. Mongo has been a downstream mirror. The rebuild inverts this:

```
                         BEFORE                         AFTER (this PRD)
  lead identity/dedup    Mongo                          Mongo
  full lead record       Zoho (blocking) → Mongo mirror Mongo (authoritative)
  lifecycle state        Zoho (blocking)                Mongo (authoritative)
  history / audit        (none — overwritten in place)  Mongo lead_events (append-only)
  automation brain       Zoho blueprints                Mongo stage machine + cron
  CRM read surface       Zoho UI                        Mongo-backed CRM UI
```

The target data flow is a single direction:

```
  ingestion sources  ──►  Mongo (persons/leads/lead_events/…)  ──►  CRM UI + automation
     (website, meta,           source of truth,                       reads only
      fim, inncircles)         event-sourced                          from Mongo
```

Zoho, once discontinued, is at most an **optional external sync target** (an
`external.zoho_lead_id` field), never on any critical read/write path.

**Non-negotiable design properties**

- **Event-sourced:** every change to a lead is first written as one immutable
  `lead_events` row. Current state is a *projection* rebuilt from those events. History
  is never overwritten — the old system's core flaw was overwriting one row so "why did
  this lead reach this stage / why was it called?" had no answer.
- **Fully indexed from day 1.** The old `leads` collection had no indexes; every
  call-guard/lookup scanned ~2,500 docs. The new model ships an idempotent
  `ensureIndexes()` that builds the full plan (§7).
- **Multi-project aware (Inncircles).** One phone can be a lead in many projects at
  once. The model tracks all of them, decides which are "active" vs "stale", and picks
  exactly one to call while handing the calling agent cross-project context (§6).

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **person** | One human, keyed by phone number. Identity across all their project enquiries. |
| **MLID** | Master Lead ID = the person's phone (E.164 digits only). `persons._id`. |
| **lead** | One `person × project` enquiry. A person can have several. |
| **PLID** | Project Lead ID = `"<phone_digits>:<PROJECT>"`, e.g. `919812345678:LOFT`. `leads._id`. |
| **event** | One immutable row in `lead_events` describing a single thing that happened to a lead. |
| **projection** | The current-state `leads` doc, derived by folding a lead's events. |
| **activation flag** | One of four Inncircles booleans that mark a lead as callable and say *why*. |
| **primary caller** | Of a person's multiple active leads, the single one that actually gets call-tracked (latest-activated). |
| **stale** | A lead with no activation flag (an Inncircles "not-interested sibling"); hidden from the CRM, kept for context. |
| **stage** | Where the lead is in the sales journey (`new … booked`). |
| **status** | Reachability sub-state, orthogonal to stage (`never_contacted … connected`). |
| **terminal** | A stage past which no automation runs (`booked/not_interested/lost/spam`). |
| **milestone** | A "sticky" stage (`visit_scheduled+`) below which automation must not drag a lead. |

---

## 3. Complete database architecture

### 3.0 Collection name map

| Logical name (use in a greenfield build) | Physical name in the reference code | Why they differ |
|---|---|---|
| `persons` | `persons` | same |
| `leads` (current state) | `crm_leads` | avoids colliding with the legacy Zoho-shaped `leads` mirror during migration |
| `lead_events` | `lead_events` | same |
| `calls` | `calls` | same |
| `messages` | `messages` | same |
| `site_visits` | `site_visits` | same |
| `stale_person_record` | `stale_person_record` | same |
| `settings` | `bot_settings` | pre-existing |
| `counters` | `_counters` | pre-existing atomic-sequence collection |
| `frozen_inbox` | `frozen_inbox` | same |
| `audit` | `audit_logs` | pre-existing |

Throughout this PRD, collections are referred to by their **logical** names. Once the
legacy `leads` mirror is retired, `crm_leads` can be renamed to `leads`.

### 3.1 Core idea: event log + projection

Think in two layers:

| Layer | Collection | Job | Write rule |
|---|---|---|---|
| **HISTORY** | `lead_events` | Permanent, immutable record of every transition / call / message / action. This is the "everything is visible" layer. | **append only** — never update, never delete |
| **NOW** | `leads` / `persons` | Today's state — stage, next action, denormalized counters. Fast reads + dashboards + cron. | update after each event (projection) |

```
  lead_events (append-only)                        leads (current state)
  ┌───────────────────────────┐                    ┌──────────────────────────┐
  │ 1 lead_created            │                    │ stage: engaged           │
  │ 2 stage_change new→…      │  ── fold/project ─► │ next_action_at: 4pm      │
  │ 3 call_completed connected│                    │ call_count: 2 conn: 1    │
  │ 4 stage_change →engaged   │                    │ event_seq: 4             │
  └───────────────────────────┘                    └──────────────────────────┘
```

**Why event sourcing:** pick any lead → read its events in time order → the whole
journey is legible. "Why was this lead called?", "when and why did the stage change?"
are answerable from data alone. Analytics (funnel conversion), audit, and debugging
come for free because history is never destroyed.

**How the projection is derived.** The projection is not recomputed from scratch on
every read — it is maintained incrementally: each mutator appends one event, then
applies the corresponding `$set`/`$inc` to the `leads` doc and advances
`event_seq` with `$max` (so the projection marker is monotonic and safe under
out-of-order writes). A lead can always be *fully rebuilt* by replaying its events in
`seq` order — that property is what makes the projection trustworthy and the store
auditable. See §10.

---

### 3.2 `persons`

One human, keyed by phone. Person-level data (name, language, budget range,
do-not-contact) lives here. All of a person's project-leads point back to it.

`_id = phone` (E.164, digits only) = **MLID**.

| Field | Type | Description |
|---|---|---|
| `_id` | string | Phone, digits-only. The person's unique identity (MLID). |
| `name` | string | Latest known name. Never overwritten with a blank. |
| `emails` | string[] | All known emails (accumulated via `$addToSet`, lower-cased). |
| `language` | string | Detected/preferred language (`en`/`hi`/`te`/…). |
| `prefs` | object | Running profile: `{ budget_min, budget_max, size, config, facing, timeline, purpose }`. Merged field-by-field; blanks never clobber known values. |
| `active_lead_ids` | string[] | All **active** project-leads (PLIDs). Can be several. All are CRM-visible. |
| `primary_caller_lead_id` | string \| null | Which active lead currently holds the call-track (the latest-activated). |
| `do_not_contact` | bool | Global kill switch — never outreach this person on any project. |
| `projects` | string[] | Denormalized list of every project this phone has enquired into (multi-project context). |
| `first_seen_at` | date | When first seen. Set on insert only. |
| `updated_at` | date | Last modification. |

Example:

```json
{
  "_id": "919812345678",
  "name": "Rahul Sharma",
  "emails": ["rahul@example.com"],
  "language": "en",
  "prefs": { "budget_min": 8000000, "budget_max": 12000000, "size": "2BHK", "purpose": "end_use" },
  "active_lead_ids": ["919812345678:LOFT", "919812345678:SPECTRA"],
  "primary_caller_lead_id": "919812345678:LOFT",
  "do_not_contact": false,
  "projects": ["LOFT", "SPECTRA", "BROADWAY", "LANDMARK"],
  "first_seen_at": "2026-07-12T06:20:00.000Z",
  "updated_at": "2026-07-24T10:00:00.000Z"
}
```

---

### 3.3 `leads` (current-state projection)

One `person × project` = one lead. This is "today's state": stage, status, next
action, and denormalized counters for fast dashboards. It is **derived from events** —
never written to without a matching event first (§10).

`_id = "<person_id>:<PROJECT>"` = **PLID**. Project is upper-cased.

| Field | Type | Description |
|---|---|---|
| `_id` | string | PLID, e.g. `919812345678:LOFT`. |
| `person_id` | string | → `persons._id` (phone). |
| `project` | string | `LOFT` / `SPECTRA` / … (upper-case). |
| `source` | string | `website` / `meta` / `fim` / `inncircles` / … |
| `born_at` | date | When the lead was born at the source (used in primary-caller tiebreak). |
| `inncircles_born_date` | date \| null | Inncircles-supplied born date (drives active/stale + primary ordering). |
| `is_born_fresh` | bool | Activation flag — brand new to Inncircles. See §6. |
| `is_reactivated` | bool | Activation flag — was not-interested in **this same** project. |
| `is_born_in_other_project` | bool | Activation flag — was not-interested in **other** projects, generated fresh in this one. |
| `is_bulk_transfer` | bool | Activation flag — bulk not-interested set, sent to reactivate. |
| `source_lead_id` | string | Inncircles' own lead id. |
| `activation_type` | enum \| null | `fresh` / `reactivated` / `born_in_other` / `bulk`. CRM tag + pitch tone. |
| `is_active` | bool | Any activation flag true → active → CRM-visible. Non-active → moved to `stale_person_record`. |
| `is_primary_caller` | bool | Of the person's active leads, is this the latest-activated (the one that gets called)? |
| `is_primary` | bool | Kept in sync with `is_primary_caller`; the field the cron's call-due query filters on. |
| `activated_at` | date | When this lead became active (drives primary-caller ordering + shift). |
| `stage` | enum | `new / contacted / engaged / qualified / visit_scheduled / visit_done / negotiation / booked / not_interested / lost / spam`. |
| `status` | enum | Reachability: `never_contacted / attempting / connected / unreachable / dnd`. |
| `is_terminal` | bool | `booked/not_interested/lost/spam` → true (no automation). |
| `next_action_at` | date \| null | **The timer.** When the next call/WA is due. `null` = nothing scheduled. |
| `next_action_type` | enum \| null | `call` / `whatsapp`. |
| `owner` | string \| null | Assigned RM, if any. |
| `counters` | object | `{ call_count, connected_count, wa_in, wa_out, docs_sent }` — denormalized. |
| `last` | object | `{ call_at, call_outcome, inbound_at, outbound_at, stage_changed_at, visit_booked_at, visit_outcome_at }`. |
| `event_seq` | int | The `seq` of the last event folded in (how far the projection has advanced). |
| `external` | object | `{ zoho_lead_id, synced }` — optional external sync bookkeeping. |
| `created_at` / `updated_at` | date | |

**WHEN vs WHETHER vs OUTCOME — keep these three separate** (this separation is what
eliminates the old "why was it called?" bug):

- `next_action_at` = **when** (the timer).
- `stage` / `is_terminal` = **whether** an action is allowed (the gate).
- `last.call_outcome` (and `calls.disposition`) = **what happened** (the result).

Example:

```json
{
  "_id": "919812345678:LOFT",
  "person_id": "919812345678",
  "project": "LOFT",
  "source": "inncircles",
  "born_at": "2026-07-20T09:03:00.000Z",
  "inncircles_born_date": "2026-07-20T00:00:00.000Z",
  "is_born_fresh": false, "is_reactivated": true,
  "is_born_in_other_project": false, "is_bulk_transfer": false,
  "source_lead_id": "INNC-88213",
  "activation_type": "reactivated",
  "is_active": true, "is_primary_caller": true, "is_primary": true,
  "activated_at": "2026-07-20T09:03:00.000Z",
  "stage": "visit_scheduled", "status": "connected",
  "is_terminal": false,
  "next_action_at": null, "next_action_type": null,
  "owner": "rm:anita",
  "counters": { "call_count": 2, "connected_count": 2, "wa_in": 1, "wa_out": 2, "docs_sent": 1 },
  "last": {
    "call_at": "2026-07-22T16:12:00.000Z", "call_outcome": "connected",
    "inbound_at": "2026-07-21T11:10:00.000Z", "outbound_at": "2026-07-20T09:03:00.000Z",
    "stage_changed_at": "2026-07-22T16:12:00.000Z"
  },
  "event_seq": 8,
  "external": { "zoho_lead_id": "5477000012345", "synced": true },
  "created_at": "2026-07-20T09:03:00.000Z",
  "updated_at": "2026-07-22T16:12:00.000Z"
}
```

---

### 3.4 `lead_events` (append-only timeline)

The heart of the design. Every single thing that happens to a lead is one immutable
row. Never updated, never deleted. The full journey of any lead is
`find({lead_id}).sort({seq})`.

`_id = auto`. The meaningful key is `{ lead_id, seq }` (unique).

| Field | Type | Description |
|---|---|---|
| `lead_id` | string | → `leads._id` (PLID). |
| `person_id` | string | → `persons._id` (for person-level history across projects). |
| `project` | string | Denormalized. |
| `seq` | int | Per-lead monotonic sequence (1, 2, 3 …). Exact order + projection tracking. Allocated atomically. |
| `ts` | date | When it happened (ISO string). |
| `type` | enum | See event-type table below. |
| `actor` | enum | Who did it: `system` / `cron` / `bot` / `rm:<id>` / `customer`. |
| `channel` | enum | `call` / `whatsapp` / `crm` / `system`. |
| `from` | object | Pre-transition `{ stage, status }` (on stage/status_change). |
| `to` | object | Post-transition `{ stage, status }`. |
| `reason` | string | Human-readable why ("call outcome: pre_site", "manual by RM", "resubmission"). |
| `ref` | string | Related record id (`call_id` / `message_id` / `visit_id`). |
| `data` | object | Type-specific payload (duration, outcome, doc_type, activation flags, …). |

**Event types** (`type` enum):

| Type | Emitted when | Key `data` / fields |
|---|---|---|
| `lead_created` | A lead first appears (active or stale). | `to.stage=new`, `source`, `source_lead_id` |
| `stage_change` | Stage moves. | `from.stage`, `to.stage`, `reason` |
| `status_change` | Reachability moves. | `from.status`, `to.status` |
| `call_scheduled` | A dial is scheduled/triggered. | `ref=call_id`, `data.provider` |
| `call_completed` | A call finishes. | `ref=call_id`, `data.outcome`, `data.disposition`, `data.duration_secs`, `data.slots` |
| `wa_inbound` | Inbound WhatsApp. | `ref=message_id`, `data.intent` |
| `wa_outbound` | Outbound WhatsApp. | `ref=message_id`, `data.intent` |
| `doc_sent` | A PDF is sent. | `data.doc_type`, `data.size_label` |
| `visit_booked` | A site/virtual visit is booked. | `ref=visit_id`, `data.scheduled_for` |
| `visit_done` | A visit is completed/no-show/cancelled. | `ref=visit_id`, `data.status` |
| `activation` | A lead activates (create / promote / activation-type change). | `data.activation_type`, `data.flags`, `data.promoted` |
| `primary_caller_shifted` | The call-track moves to a newer active lead. | `data.from`, `data.to` |
| `assignment` | An RM is assigned. | `data.owner` |
| `note` | Free-text note. | `data.text` |
| `system` | System bookkeeping (e.g. `scheduleNextAction`). | `data.next_action_at`, `data.next_action_type` |

**The rule:** when any lead state changes, **(a)** append the event first, **(b)**
then update the `leads` projection. Never change state without an event — that is what
keeps history 100% complete.

Example event (a `call_completed` that captured a site visit):

```json
{
  "lead_id": "919812345678:LOFT",
  "person_id": "919812345678",
  "project": "LOFT",
  "seq": 7,
  "ts": "2026-07-22T16:12:00.000Z",
  "type": "call_completed",
  "actor": "bot",
  "channel": "call",
  "ref": "call_9f2a...",
  "reason": "call connected · disposition pre_site",
  "data": {
    "outcome": "connected",
    "disposition": "pre_site",
    "duration_secs": 118,
    "slots": { "visit_date": "2026-07-27T11:00:00.000Z" }
  }
}
```

---

### 3.5 `calls`

One detail record per dial. Linked from events via `ref = call_id`.

`_id = call_id` (the correlation key the post-call webhook matches on).

| Field | Type | Description |
|---|---|---|
| `_id` | string | Call id / correlation key. |
| `lead_id` | string | → `leads._id`. |
| `person_id` / `phone` | string | |
| `scheduled_at` | date | When scheduled. |
| `dialed_at` | date | When dialed. |
| `provider` | enum | `plivo` / `telnyx`. |
| `outcome` | enum | **Connection** result: `connected / no_answer / busy / switched_off / failed`. |
| `disposition` | enum | **Semantic** bot result: `pre_site / virtual_tour / callback / not_interested / info`. |
| `duration_secs` | int | |
| `recording_url` | string | |
| `transcript` | string \| ref | Transcript or a pointer to it. |
| `slots` | object | Extracted `{ visit_date, callback_time }`. |

**Hard lesson — `outcome` and `disposition` are SEPARATE fields.** The old system's
bug: the voice bot knew the semantic result (`pre_site`) but only ever sent the
connection outcome (`connected`), so the CRM never learned a site visit was captured.
Store the semantic disposition in its own field, always.

---

### 3.6 `messages`

WhatsApp chat, inbound + outbound. **Phone-level** (independent of project — WhatsApp
is tied to a phone, not a project enquiry). One message = one row.

`_id = message_id` (provider id, also used for dedupe against retries).

| Field | Type | Description |
|---|---|---|
| `_id` | string | Provider message id (dedupe key). |
| `person_id` / `phone` | string | |
| `direction` | enum | `inbound` / `outbound`. |
| `body` | string | Text. |
| `ts` | date | |
| `sender` | string | Which ASBL number sent it (sticky sender pool). |
| `intent` | string | Detected intent (`price` / `brochure` / `call_me` / …). |
| `project` | string \| null | Resolved project, if any. |
| `doc_ref` | string \| null | Which PDF was sent, if any. |

A message may also emit a `wa_inbound` / `wa_outbound` event **on the lead it is
attributed to** (usually the person's primary lead) and bump that lead's `wa_in`/
`wa_out` counters. The message row itself is phone-level and always stored, even when
there is no lead to attribute the event to.

---

### 3.7 `site_visits`

One row per booking.

`_id = visit_id`.

| Field | Type | Description |
|---|---|---|
| `_id` | string | Visit id. |
| `lead_id` / `person_id` | string | |
| `project` | string | |
| `type` | enum | `site` / `virtual`. |
| `scheduled_for` | date | Visit date + time. |
| `status` | enum | `booked / done / no_show / cancelled`. |
| `booked_via` | enum | `call` / `whatsapp` / `rm`. |
| `created_at` | date | |

Booking a visit writes this row (status `booked`) + a `visit_booked` event. It does
**not** by itself change stage — the caller pairs it with
`stage_change → visit_scheduled` so the milestone/automation-stop is explicit.

---

### 3.8 `stale_person_record`

Inncircles "not-interested siblings" — leads where **all four activation flags are
false**. Kept out of the active `leads` collection so the CRM/cron only ever read
callable, CRM-visible leads (zero chance of accidentally calling or showing a stale
lead), but retained so the calling agent has full cross-project context.

`_id = PLID` (same key space as `leads`). Hidden from the CRM.

| Field | Type | Description |
|---|---|---|
| `_id` | string | PLID (same as `leads`). |
| `person_id` | string | → `persons._id`. All of a person's not-interested projects live here. |
| `project` / `source` | string | |
| `inncircles_born_date` | date | Preserved. |
| `flags` | object | `{ is_born_fresh, is_reactivated, is_born_in_other_project, is_bulk_transfer }` — all false. |
| `stale_reason` | enum | `not_interested_sibling` (no activation flag arrived). |
| `last_stage` | enum \| null | If it was ever active, its previous stage (restored on promotion). |
| `event_seq` | int | Its events still live in `lead_events` (by `lead_id`). |

**Promotion:** if an activation flag later arrives for a stale project
(`reactivated` / `born_in_other` / `bulk`), the record is **promoted** into `leads`
(emitting an `activation` event, reason "promoted from stale"), carrying forward any
`last_stage`. History is intact throughout because events are keyed by `lead_id`, which
does not change.

**Demotion does not exist:** if an all-false push arrives for a lead that is *already
active*, it does **not** demote it. Inncircles never demotes; only the call-track can
shift (§6).

---

### 3.9 Support / config collections

| Collection | `_id` | Job |
|---|---|---|
| `settings` | `key` | Toggles / config (pauses, `automation_frozen`, model, prompt). |
| `counters` | `name` | Atomic ID sequences (person/lead/call ids, and the per-lead `crm_ev:<lead_id>` event sequence). |
| `senders` | `number` | WhatsApp sender pool + sticky map + dead-sender TTL. |
| `frozen_inbox` | auto | Raw payloads captured during a rebuild/freeze, for later replay. **TTL 30 days** — `at` must be a BSON `Date` (Mongo ignores string-valued fields for TTL expiry). |
| `audit` | auto | Log of admin/manual actions (who changed what). |

---

## 4. The stage machine

Stages are a small, fixed enum with allowed transitions. Every transition writes one
`stage_change` event.

```
   new ──►  contacted ──►  engaged ──►  qualified
   (1st       (replied/      (budget+intent)  │
    call/wa)   connected)                      ▼
                                        visit_scheduled ──► visit_done ──► negotiation ──► booked (won)

   from ANY stage ─ ─►  not_interested | lost | spam      (terminal — no automation)
```

- **Stages:** `new, contacted, engaged, qualified, visit_scheduled, visit_done,
  negotiation, booked, not_interested, lost, spam`.
- **Terminal** (`is_terminal=true`, no automation, `next_action_at` cleared):
  `booked, not_interested, lost, spam`.
- **Milestone / sticky** (automation must not drag a lead *below* these):
  `visit_scheduled, visit_done, negotiation, booked`.
- **Parallel `status` axis (reachability)**, independent of stage:
  `never_contacted → attempting → connected / unreachable / dnd`.
  `stage` = the journey; `status` = whether we can reach the phone. They move
  independently.

You may rename stage labels to fit the business; the **structure** (clean enum +
allowed transitions + an event on every change + terminals stop everything + milestones
are sticky) is what matters.

---

## 5. Worked example: a lead's full timeline

The whole point of "everything is visible": read a lead's `lead_events` in time order
and the entire story is legible. Example — Rahul, project LOFT
(`lead_id = 919812345678:LOFT`):

| seq | ts | type | what happened |
|---|---|---|---|
| 1 | 20 Jul 09:03 | `lead_created` | source **inncircles**, project **LOFT**, stage set **new**. |
| 2 | 20 Jul 09:03 | `activation` | activation_type **reactivated** (was not-interested in LOFT before). |
| 3 | 20 Jul 09:03 | `wa_outbound` | T=0 greeting sent. status → **attempting**. |
| 4 | 20 Jul 09:05 | `call_completed` | **connected**, 1m31s, disposition **info**. |
| 5 | 20 Jul 09:05 | `stage_change` | `new → contacted → engaged`, reason "call connected". status → **connected**. |
| 6 | 21 Jul 11:10 | `wa_inbound` | Customer: "2BHK price?" intent **price**. |
| 7 | 21 Jul 11:11 | `doc_sent` | price_sheet, 2BHK LOFT. |
| 8 | 22 Jul 16:12 | `call_completed` | **connected**, disposition **pre_site**, slot `visit_date=27 Jul 11:00`. |
| 9 | 22 Jul 16:12 | `stage_change` | `engaged → visit_scheduled`, reason "call disposition: pre_site". **Automation stops** (milestone). `next_action_at=null`. |
| 10 | 22 Jul 16:12 | `visit_booked` | site_visits row: 27 Jul 11:00, status **booked**. |
| 11 | 27 Jul 12:30 | `stage_change` | `visit_scheduled → visit_done`, actor **rm:anita**. |

What this buys you, all answerable from data with zero guesswork:
- "Why is this lead in `visit_scheduled`?" → the 22 Jul pre_site call (seq 8–9).
- "How many times was it called?" → count `call_completed` events (or read
  `counters.call_count`).
- "When and why did automation stop?" → the milestone `stage_change` at seq 9.

The corresponding **projection** after seq 11 is the `leads` doc in §3.3.

---

## 6. Inncircles multi-project logic (full)

Inncircles pushes one phone into many projects. This is the most subtle part of the
system; build it exactly.

### 6.1 The four activation flags — exact meanings

Each pushed lead carries (at a given time) **one** activation flag. **All four flags
mean "active + call"** — they differ only in *why*, which is captured as
`activation_type` and used for CRM tagging and the calling agent's pitch tone.

| Flag `true` | State in Inncircles before | Exact meaning | `activation_type` | Result |
|---|---|---|---|---|
| `is_born_fresh` | **never existed** in Inncircles | Brand new lead, first time ever. | `fresh` | **active + call** |
| `is_reactivated` | not-interested in the **SAME** project | Campaign reactivated them in that same project. | `reactivated` | **active + call** |
| `is_born_in_other_project` | not-interested in **OTHER** projects | Generated fresh in a **new** project (differs from `fresh`: they *were* in Inncircles before, just for other projects). | `born_in_other` | **active + call** |
| `is_bulk_transfer` | not-interested (**bulk**) | Sent in a bulk batch to be reactivated (call + WhatsApp). | `bulk` | **active + call** |
| — **all four false** — | not-interested | A project the person is not interested in (a "sibling"). | `null` | **stale · hidden** |

Classification rules (implemented in `classifyActivation`):

1. **Any one flag true → active.** Priority if (defensively) more than one is set:
   `fresh > reactivated > born_in_other > bulk`.
2. **All four explicitly false → stale** → write to `stale_person_record`
   (`stale_reason = not_interested_sibling`), never to `leads`.
3. **No flag info at all** (a non-Inncircles source: website/meta/fim, or Inncircles
   omitting the flags) → treat as a normal **`fresh` active** lead. This distinction —
   "explicitly all-false" vs "no info" — matters: a website lead must not be misfiled
   as a stale sibling.

Store on the `leads` doc: `activation_type` plus the four booleans. The `activation`
event carries `{ activation_type, flags }` so the reasoning is in history too.

### 6.2 Multiple active + one primary caller

A person can activate in several projects at different times (e.g. SPECTRA
`born_in_other` on day t1, then LOFT `reactivated` on day t2). Then:

| Concern | Rule |
|---|---|
| **CRM visible** | **All active** projects show (SPECTRA + LOFT both). |
| **Call-track** | Only the **latest-activated** is `primary_caller` (LOFT). Others are active but not called — they exist for context. |
| **A newer activation** | The new one becomes `primary_caller`; the previous active **stays active** (it is *not* made stale — only the call-track shifts). Emits a `primary_caller_shifted` event. |
| **Tiebreak** (ordering) | latest `activated_at`, then `inncircles_born_date`, then `born_at`, then `_id`. |

Reference ordering (`comparePrimary` / `recomputePrimaryCaller`): sort a person's
active leads by `activated_at` desc; break ties by `inncircles_born_date` desc, then
`born_at` desc, then `_id`. The first is the primary caller. When it changes, flip
`is_primary_caller`/`is_primary` on the docs, update
`persons.{active_lead_ids, primary_caller_lead_id}`, and append
`primary_caller_shifted` on the new primary.

```
  person (4 projects)              leads (active)                      stale_person_record
  ┌──────────┐   reactivated t2 ─► ┌───────────────────────────┐      ┌───────────────────────┐
  │  phone   │──► LOFT (t2) ★──────│ LOFT   ★ = primary caller │      │ BROADWAY  all-false   │
  │          │──► SPECTRA (t1)─────│ SPECTRA = active (context)│      │ LANDMARK  all-false   │
  │          │──► BROADWAY ───────────────────────────────────────►  │ hidden · data safe    │
  │          │──► LANDMARK ────────────────────────────────────────► └───────────────────────┘
  └──────────┘
     both LOFT + SPECTRA show in CRM · call fires only on LOFT · not-interested → stale
```

### 6.3 Cross-project context handed to the calling agent

When the orchestrator fires the primary caller, it hands the calling agent the full
cross-project picture so the agent talks with continuity and never re-pitches a
declined project. Payload (built by `buildCallerContext(phone)`):

| Field | Why |
|---|---|
| `current` = `{ project, stage, activation_type }` | Which project is being called now, at what stage, and the pitch tone (fresh/reactivated/born_in_other/bulk). |
| `other_active[]` = `{ project, stage, activation_type }` | "You're at visit_done in LOFT; now about SPECTRA…" — continuity across the person's other live projects. |
| `not_interested[]` = `{ project }` | "You weren't interested in Broadway earlier" — don't re-pitch it. |
| `do_not_contact` | Global kill — if true, do not call at all. |

Example payload:

```json
{
  "person_id": "919812345678",
  "primary_caller_lead_id": "919812345678:LOFT",
  "current": { "project": "LOFT", "stage": "visit_scheduled", "activation_type": "reactivated" },
  "other_active": [ { "project": "SPECTRA", "stage": "engaged", "activation_type": "born_in_other" } ],
  "not_interested": [ { "project": "BROADWAY" }, { "project": "LANDMARK" } ],
  "do_not_contact": false
}
```

All of this is also recorded in `lead_events` (`activation`,
`primary_caller_shifted`), so "what context was the call made with" is itself part of
history.

---

## 7. Indexing plan (full)

Without indexes every query full-scans the collection (slow + expensive). Ship an
idempotent `ensureIndexes()` that builds all of these on first write (and expose an
admin endpoint to force-rebuild + list them). `_id` indexes are automatic and unique —
no explicit `createIndex` needed.

| Collection | Index | Type | Why / which query |
|---|---|---|---|
| `persons` | `_id` (phone) | unique (auto) | Fetch person by phone. |
| `persons` | `{ primary_caller_lead_id }` | single | Resolve the primary lead. |
| `leads` | `_id` (PLID) | unique (auto) | Fetch a specific lead. |
| `leads` | `{ person_id }` | single | All of a phone's project-leads (multi-project dedup / person view). |
| `leads` | `{ stage, next_action_at }` | compound | **Cron core:** leads whose stage is active AND `next_action_at` is due. Filter + sort together. |
| `leads` | `{ is_primary, next_action_at }` | compound | Only primary callers that are due. |
| `leads` | `{ is_primary_caller, next_action_at }` | compound | Same, on the semantic flag (kept in sync with `is_primary`). |
| `leads` | `{ external.zoho_lead_id }` | sparse | Lookup by external id (during sync). |
| `lead_events` | `{ lead_id, seq }` | compound, **unique** | A lead's full timeline in order — **the single most important index**. Also blocks duplicate `seq`. |
| `lead_events` | `{ person_id, ts }` | compound | Person-level history across all projects. |
| `lead_events` | `{ type, ts }` | compound | Analytics ("how many stage_change / pre_site today"), funnel reports. |
| `lead_events` | `{ lead_id, type, ts }` | compound | A single lead's calls-only / messages-only slice. |
| `calls` | `_id` (call_id) | unique (auto) | Post-call webhook correlation. |
| `calls` | `{ lead_id }` | single | A lead's calls. |
| `calls` | `{ outcome, dialed_at }` | compound | Connected-rate reports per day. |
| `calls` | `{ scheduled_at }` | single | Due calls / cleanup. (Not a TTL — call history must not auto-delete.) |
| `messages` | `_id` (message_id) | unique (auto) | Dedupe provider retries. |
| `messages` | `{ person_id, ts }` | compound | Chat history (last 30 days, ordered) — fast inbound-context lookup. |
| `messages` | `{ direction, ts }` | compound | Reports. |
| `site_visits` | `_id` (visit_id) | unique (auto) | |
| `site_visits` | `{ lead_id }` | single | A lead's visits. |
| `site_visits` | `{ status, scheduled_for }` | compound | "Today/tomorrow's booked visits", reminders. |
| `stale_person_record` | `_id` (PLID) | unique (auto) | |
| `stale_person_record` | `{ person_id }` | single | A person's stale projects (context + promote lookup). |
| `stale_person_record` | `{ person_id, inncircles_born_date }` | compound | Find latest-born stale on promotion. |
| `frozen_inbox` | `{ at }` | **TTL** (`expireAfterSeconds: 2592000`) | Auto-expire raw payloads after 30 days. `at` must be a BSON `Date`. |

**Compound-index golden rule (ESR):** field order is **Equality → Sort → Range**.
That is why `leads {stage, next_action_at}` puts `stage` (equality) first and
`next_action_at` (range/sort) second — perfect for the cron's exact query.

```js
// leads — cron's main index
db.leads.createIndex({ stage: 1, next_action_at: 1 })
// lead_events — timeline (unique per lead+seq)
db.lead_events.createIndex({ lead_id: 1, seq: 1 }, { unique: true })
db.lead_events.createIndex({ person_id: 1, ts: 1 })
db.lead_events.createIndex({ type: 1, ts: 1 })
// messages — inbound context lookup
db.messages.createIndex({ person_id: 1, ts: -1 })
// TTL — cap the rebuild inbox
db.frozen_inbox.createIndex({ at: 1 }, { expireAfterSeconds: 2592000 })
```

---

## 8. Data contracts the CRM UI needs

These are the read/write shapes the CRM front end and automation depend on. All reads
below hit an index from §7.

### 8.1 Reads

**R1 — A lead's full timeline** (lead detail page)
```js
lead_events.find({ lead_id }).sort({ seq: 1 })      // index: {lead_id, seq}
```
Returns the ordered event list rendered as §5's table. Pair with
`leads.findOne({_id: lead_id})` for the current-state header (stage/status/counters).

**R2 — Active leads by stage** (pipeline / kanban board)
```js
leads.find({ is_active: true, stage: <STAGE> })     // index: {stage, next_action_at}
     .sort({ next_action_at: 1 })
```
For a full board, group by `stage`. Stale leads are in a different collection, so they
never leak in.

**R3 — Call-due leads** (cron / dialer feed)
```js
leads.find({ stage: { $in: ACTIVE_STAGES }, is_primary: true,
             next_action_at: { $lte: now } })       // index: {stage, next_action_at} / {is_primary, next_action_at}
```
`ACTIVE_STAGES` = all non-terminal stages. `is_primary` ensures only the primary caller
of a multi-active person is dialed.

**R4 — A person's all projects (active + stale)** (person 360 view)
```js
const active = leads.find({ person_id })                     // index: {person_id}
const stale  = stale_person_record.find({ person_id })       // index: {person_id}
```
Merge for the full multi-project picture. `persons.active_lead_ids` and
`primary_caller_lead_id` give the summary without a scan.

**R5 — Inbound chat context** (WhatsApp reply handler)
```js
messages.find({ person_id }).sort({ ts: -1 }).limit(80)      // index: {person_id, ts}
```

**R6 — Funnel analytics** (dashboard)
```js
lead_events.countDocuments({ type: "stage_change",
   "to.stage": "visit_scheduled", ts: { $gte: startOfDay } }) // index: {type, ts}
```
Any funnel step = a count of `stage_change` events into that stage over a window.

**R7 — Calling-agent cross-project context** (orchestrator, before a call)
`buildCallerContext(phone)` → the §6.3 payload.

**R8 — Today's booked visits** (RM ops)
```js
site_visits.find({ status: "booked",
   scheduled_for: { $gte: startOfDay, $lt: endOfDay } })      // index: {status, scheduled_for}
```

### 8.2 Writes (through the mutators, never direct)

Every write goes through a helper that enforces the golden rule (append event →
project). The CRM UI and integrations call these; they do not touch collections
directly.

| Intent | Helper | Emits event(s) | Projection effect |
|---|---|---|---|
| Ingest a new lead | `recordIngestToNewModel(input)` | `lead_created` (+ `activation` if active) | creates `leads` **or** `stale_person_record` doc; recomputes primary caller |
| Move stage | `changeStage(lead_id, toStage, opts)` | `stage_change` | `stage`, `is_terminal`, `last.stage_changed_at`; clears timer if terminal |
| Move status | `changeStatus(lead_id, toStatus, opts)` | `status_change` | `status` |
| Set/clear the timer | `scheduleNextAction(lead_id, at, type, opts)` | `system` | `next_action_at`, `next_action_type` |
| Schedule a dial | `recordCallScheduled(input)` | `call_scheduled` | writes `calls` doc, `call_count++`, `last.call_at` |
| Complete a call | `recordCallCompleted(input)` | `call_completed` | updates `calls` doc, `connected_count++` (if connected), `last.call_outcome`; **disposition in its own field** |
| Store a WhatsApp msg | `recordMessage(input)` | `wa_inbound`/`wa_outbound` | writes `messages` doc, `wa_in`/`wa_out++`, `last.inbound_at`/`outbound_at` |
| Send a document | `recordDocSent(lead_id, docType, opts)` | `doc_sent` | `docs_sent++` |
| Book a visit | `recordSiteVisitBooked(input)` | `visit_booked` | writes `site_visits` doc (pair with `changeStage("visit_scheduled")`) |
| Visit outcome | `recordSiteVisitOutcome(visit_id, status, opts)` | `visit_done` | updates `site_visits` status |
| Recompute primary | `recomputePrimaryCaller(person_id)` | `primary_caller_shifted` (if it moves) | flips `is_primary_caller`/`is_primary`; updates `persons` |

---

## 9. Ingestion → Mongo → CRM data flow

There are four ingestion sources; all funnel through one path so behavior is uniform.

```
  website ─┐
  meta ────┤ (Meta Lead Ads webhook)
  fim ─────┤ (landing pages)                 ──►  ingestLead()  ──►  Mongo (source of truth)
  inncircles┘ (multi-project push + 4 flags)                          │
                                                                       ├─ persons (upsert)
                                                                       ├─ leads  OR  stale_person_record
                                                                       ├─ lead_events (lead_created [+ activation])
                                                                       └─ recompute primary caller
                                                                       │
                                                          (optional, non-blocking) external Zoho sync
                                                                       │
                                              CRM UI + automation read ONLY from Mongo
```

Step by step (per the reference `ingestLead`):

1. **Normalize the payload** to a common lead shape. The Inncircles normalizer extracts
   the four activation flags into `inncircles_flags` and the original `born_date`.
2. **Resolve identity in Mongo (authoritative):** MLID (phone) → PLID (`phone:PROJECT`).
   Dedup and claim are Mongo-first.
3. **Write the full lead to Mongo BEFORE anything external.** The lead is durable
   regardless of whether any external system is reachable.
4. **Populate the event-sourced model** (`recordIngestToNewModel`): upsert `persons`,
   classify activation, create the `leads` doc (active) or `stale_person_record`
   (all-false sibling), append `lead_created` (+ `activation`), recompute the primary
   caller. This is best-effort and wrapped so it can never fail ingest.
5. **External sync is optional and non-blocking.** If an external CRM (Zoho, during the
   transition) is written, its id is stamped back onto the Mongo doc
   (`external.zoho_lead_id`, `synced=true`) only when it actually lands; failures fall
   through to a reconcile queue and never lose or block the lead.
6. **The CRM UI and all automation read from Mongo only.**

**Freeze behavior (operational):** while `settings.automation_frozen = true`, the
ingest handlers archive the raw payload to `frozen_inbox` and return early *before*
`ingestLead` — so the new model is not populated live during a freeze. Population
resumes automatically once the freeze lifts or the `frozen_inbox` is replayed.

---

## 10. The golden write rule (every mutation)

This is the invariant that makes the whole design work. Build every mutator this way:

```
  function mutate(lead, change):
      seq   = nextSeq(lead_id)            # atomic per-lead counter
      event = appendEvent({ lead_id, person_id, project, seq, ts,
                            type, actor, channel, from, to, reason, ref, data })
      projectLead(lead_id, seq,           # update current-state doc
                  $set: <fields from change>,
                  $max: { event_seq: seq },
                  $inc: <counters>)
```

- **Event first, projection second.** Never mutate `leads` without an event.
- **`seq` is atomic and per-lead**, allocated from the `counters` collection
  (`crm_ev:<lead_id>`). The unique `{lead_id, seq}` index blocks accidental duplicates.
- **`event_seq` is advanced with `$max`**, so the projection marker never goes
  backwards even under concurrent/out-of-order writes.
- **Events are append-only** — no update, no delete, ever. A lead can be fully rebuilt
  by replaying its events in `seq` order; that is the guarantee that makes the
  projection auditable and safe.
- **Mutators are idempotent where it matters:** re-ingesting the same (phone, project)
  does not duplicate `lead_created`/`activation`; `no-op` transitions (already at the
  target stage/status) append nothing.

---

## 11. Migration / cutover plan

The reference code already implements the **ingest** path into the new model and the
full write layer + indexes. To reach a Zoho-free CRM:

1. **Backfill history.** Run the legacy-`leads` → new-model backfill (dry-run first,
   then commit). It maps legacy stage/status → the new enums, pulls the four flags
   (undefined-preserving, so flagless legacy docs classify as fresh-active, not stale),
   skips phone-less docs, and applies the historical stage via idempotent
   `changeStage`. Idempotent — re-running does not double-write history.
2. **Wire the runtime paths** to emit events into the new model (see §12, gap 1): the
   WhatsApp inbound handler → `recordMessage`; the outbound call trigger →
   `recordCallScheduled`; the post-call webhook → `recordCallCompleted` +
   `changeStage`; visit flows → `recordSiteVisitBooked`/`Outcome`; all stage/status
   changes → `changeStage`/`changeStatus`. Until this is done, the new model only ever
   sees `lead_created`/`activation`.
3. **Port the cadence engine's read to Mongo** (§12, gap 2): change the cron from
   paging the lead corpus out of Zoho to the R3 call-due query on `leads`. Verify parity
   against a Zoho snapshot before flipping.
4. **Unify the current-state store.** Point the Mongo-first state machine at the new
   `leads`/`crm_leads` projection (not the legacy flat `leads` mirror), so there is one
   authoritative current-state collection.
5. **Retire the Zoho→Mongo sync** once every write path is Mongo-authoritative and a
   person/lead can be created in Mongo without any Zoho record.
6. **Discontinue Zoho.** Keep `external.zoho_lead_id` only if an outbound sync is still
   wanted; otherwise drop it.

---

## 12. Remaining gaps (honest status)

State of the reference implementation at the time of this PRD. The **write layer,
Inncircles classification, primary-caller logic, and full index set are implemented and
type-clean** (`npx tsc --noEmit -p .` passes, exit 0). The following are **not yet
done** and a builder must complete them:

1. **Runtime paths are not wired into the new model (biggest gap).** Only the *ingest*
   path calls the new mutators. The WhatsApp inbound handler, outbound call trigger,
   post-call webhook, and the stage/status state machine do **not** yet emit
   `wa_*`/`call_*`/`visit_*`/`stage_change`/`status_change` events into the new
   collections. The helpers exist and compile but are unwired — so today the new model
   would only ever contain `lead_created` / `activation` / `primary_caller_shifted`.
   The §5 timeline cannot be produced end-to-end at runtime until this wiring lands.
2. **The cadence engine still reads from Zoho.** The daily cron pages the lead corpus
   out of Zoho, not from the Mongo R3 query. This is the single biggest remaining Zoho
   read on a critical path. Port + verify parity before unfreeze.
3. **Two parallel current-state stores exist during migration.** The legacy Zoho-shaped
   `leads` mirror (which the frozen automation + the Mongo-first state path use) and the
   new `crm_leads` projection (populated only by ingest + backfill). They are not yet
   unified; the runtime state machine writes to the legacy one.
4. **The backfill has not been run for real** (dry-run default). The historical corpus
   is not in the new model until it is committed. Flagless legacy docs classify as
   fresh-active.
5. **New-model population is paused under the current freeze.** `automation_frozen=true`
   makes ingest archive to `frozen_inbox` before reaching `ingestLead`. Live population
   resumes on unfreeze / replay.
6. **Zoho is still the automation brain for blueprints.** No Mongo stage machine drives
   outbound automation yet; blueprint transitions on the Zoho `Lead_Status` still
   govern. The `leads.stage` + `lead_events` model is the intended replacement — a build
   item, not a rewire.
7. **A few reads still hit Zoho** (post-call lead lookup by call-id/phone, the
   resubmission dedup read). Each should move to Mongo (both keys are mirrored/indexed)
   with its own verification pass.
8. **`audit` TTL is a deliberate human decision, not applied.** The architecture groups
   `frozen_inbox`/`audit` under TTL; only `frozen_inbox` has a TTL in code. Auto-expiring
   the compliance/audit trail after 30 days is a data-retention call, left to a human.
9. **`calls.scheduled_at` is a plain index, not a TTL.** The architecture marks it
   "TTL?"; auto-deleting call records would destroy history, so it is intentionally not
   a TTL.

None of these are correctness defects in the implemented write logic — they are the
remaining **wiring / migration / operational** phases.

---

## 13. Reference implementation map

Where the already-built pieces live (all paths relative to the repo root):

| Concern | File |
|---|---|
| Event-sourced write layer (all mutators, classification, primary-caller, caller context, `ensureCrmIndexes`) | `api/_utils/crm_model.ts` |
| Collection name constants + `getCollection` + `getNextSequence` | `api/_utils/mongo.ts` |
| Legacy→new-model backfill (dry-run default) | `api/_utils/crm_backfill.ts` |
| Ingest path (Mongo-first, wired to `recordIngestToNewModel`) | `api/_utils/ingest.ts` |
| Admin endpoints: `action=backfill-new-model`, `action=ensure-crm-indexes` | `api/chat-history.ts` |
| Mongo-first state transitions (legacy projection) | `api/_utils/prd_state_machine.ts` |
| Freeze archive (`frozen_inbox`, BSON-`Date` `at` for TTL) | `api/_utils/automation_freeze.ts` |

Visual source of design truth (read alongside this PRD): `db_architecture.html`.

---

*End of PRD.*
