# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo at a glance

`asbl-crm-api` is a Vercel-hosted set of TypeScript serverless functions (under `api/`) that glue together:

- **Periskope** (WhatsApp BSP) for inbound/outbound chat
- **Google Gemini 3 Pro** for intent classification + reply (single call, structured JSON output)
- **In-house ASBL Voice Bot ("Anandita")** for outbound calling (replaced Arrowhead)
- **Zoho CRM** (Indian region — `zohoapis.in`) for lead state
- **Supabase** for chat history, KB, doc storage, bot settings
- **Google Sheets** as the live inventory + pricing source of truth

Every endpoint lives at the top level of `api/` (or one nested folder deep). Files in `api/_utils/` are shared helpers and are **not** counted as functions.

## Commands

```bash
# Type-check the whole project (no emit)
npx tsc --noEmit -p .

# Local dev (rarely used — most testing is via deployed staging)
npm run dev

# Deploy: every push to main on https://github.com/1Mukund/asbl-crm-api auto-deploys via Vercel
```

There is **no test suite** and no linter configured. Verification is done by curl-ing deployed endpoints and reading Vercel function logs.

## Hard constraints (read before changing structure)

1. **Vercel Hobby plan caps serverless functions at 12.** The repo is permanently at the limit. Never add a new top-level file under `api/` (or nested) without removing one first. Count: `find api -type f \( -name "*.ts" -o -name "*.js" \) -not -path "*/_utils/*" | wc -l` should equal 12. Helpers go in `api/_utils/`.

2. **Vercel deploy is gated on commit author.** Vercel resolves the commit's author email to a GitHub user, then to a Vercel account, then checks team membership. The repo `1Mukund/asbl-crm-api` is deployed by the Pro team `balmukund21xxx074-akgecacins-projects` whose owner is the Vercel account `balmukund21xxx074-8026`. Always commit with:
   ```bash
   git -c user.email="mukundasbl@gmail.com" -c user.name="1Mukund" commit ...
   ```
   Why this works: `mukundasbl@gmail.com` is registered to the `1Mukund` GitHub user. As of 2026-06-03 (late), the `1Mukund` GitHub identity is **only** linked to the `balmukund21xxx074-8026` Vercel account (the team owner) — the conflicting link to the personal Hobby account `mukundasbl-5482` was deliberately removed. So Vercel's resolution chain lands cleanly on the owner: ✅ auto-deploy, no manual Redeploy needed.

   Timeline of this email saga (so future sessions don't re-litigate it):
   - Pre-2026-06-03: `mukundasbl@gmail.com` worked because `mukundasbl-5482` was a team member.
   - 2026-06-03 mid-day: `mukundasbl-5482` got removed from the team — commits started landing as "Blocked".
   - Tried the GitHub noreply email and `balmukund21xxx074@akgec.ac.in` (which resolves to a different GitHub user `mukund9162` that has no Vercel link) — both got auto-blocked too.
   - 2026-06-03 late: Identified the root cause — `1Mukund` GitHub had been linked to *two* Vercel accounts (`mukundasbl-5482` and `balmukund21xxx074-8026`), and Vercel was resolving to the wrong (non-team) one. Disconnecting GitHub from the personal Hobby account fixes the resolution permanently. Don't add a second GitHub link to `1Mukund` from any Vercel account again — it'll re-introduce the same ambiguity.

   The local stored `git config` is intentionally **not** updated (safety rule). Do not run `git config --global user.email`.

3. **Vercel env-var changes need a redeploy.** Saving an env var doesn't hot-swap into the runtime — push an empty commit with `git commit --allow-empty -m "chore: redeploy ..."` to force a rebuild, or expect a stale runtime.

4. **Vercel Hobby request body limit is ~4.5 MB.** PDF uploads through serverless POST will return a plain-text "Request Entity Too Large" — the `chat-history.ts` upload flow handles this by issuing a **Supabase signed PUT URL** so the browser uploads the file directly to Storage; only metadata transits Vercel.

5. **Awaiting in serverless.** When fanning out write calls (Zoho, Supabase), use `await` or `Promise.allSettled([...])` — `.catch()` fire-and-forget will be killed mid-flight when the handler returns. Look at `api/relay/inhouse-posthook.ts` for the correct pattern (createCallLog + createCallNote).

## Architecture map

### Endpoints (12 functions, current)

```
api/chat-history.ts          ⭐ Multi-purpose: dashboard UI, KB upload signed-URL flow,
                                 prompt editor, lead inspector, /action=meta-token-check.
                                 Rendered HTML views + ?action=... POST handlers.
api/normalize-zoho-lead.ts   Webhook for Zoho's lead-create automation.
api/cron/followup.ts         Daily cron (10:00 IST). Sends 10-day follow-up template
                                 sequence. Hardcoded "ASBL Loft" copy — NOT project-aware.
api/ingest/fim.ts            Lead intake from FIM landing pages.
api/ingest/meta.ts           Lead intake webhook from Meta Lead Ads (Facebook).
                                 Uses META_PAGE_ACCESS_TOKEN (must be a long-lived
                                 System User token; user tokens expire in 60d).
api/ingest/website.ts        Lead intake from main asbl.in forms.
api/relay/inhouse-call.ts    Outbound call trigger → ASBL voice bot /api/trigger-call.
                                 Replaces the deprecated Arrowhead relay.
api/relay/inhouse-posthook.ts Receives call_completed webhook from voice bot;
                                 updates Zoho lead, fires blueprint transition,
                                 creates Note + Call log.
api/relay/lazybot-webhook.ts Legacy Lazybot integration.
api/relay/periskope-webhook.ts ⭐ Main WhatsApp inbound handler. Calls Gemini, replies,
                                 saves both directions to Supabase, updates Zoho.
api/relay/periskope.ts       Outbound Periskope helpers (round-robin sender pool).
api/relay/whatsapp.ts        Earlier WhatsApp send helper (kept; some Deluge funcs use).
```

### Periskope inbound flow (`api/relay/periskope-webhook.ts`)

This is the highest-traffic codepath and the riskiest place to break things.

```
1. Customer texts ASBL number
2. Periskope POSTs message.created event
3. Filter: inbound only, valid phone, non-empty body
4. Best-effort Zoho lookup (cached token via 2-tier cache: module-level
   + Supabase bot_settings.zoho_access_token_v1 — without this Zoho's
   OAuth /token endpoint rate-limits under burst load)
5. Fetch last 30d conversation history from Supabase
6. Resolve project: regex on message > Zoho ASBL_Project field > last-asked
7. Build PROJECT_CONTEXT = kb_text + facts_text (offers) + live inventory
8. Single Gemini call → returns { intent, flags, project, doc_to_send, reply }
9. Save outbound row to Supabase BEFORE Periskope send (so the conversation
   history is consistent for the customer's next message)
10. 1.5s "typing" delay → Periskope send (with 1 retry on 5xx)
11. If doc_to_send is set → look up project_documents → send PDF via Periskope
12. Update Zoho: Last_Intent + Whatsapp_Replied
```

Gemini's reply is the JSON's `reply` field. **Three-tier parser** in `api/_utils/gemini_chat.ts`:
1. Full `JSON.parse` (happy path)
2. Regex-extract `"reply":"..."` from malformed/truncated JSON (recovers from MAX_TOKENS)
3. Friendly humanlike fallback ("Hmm, give me a sec — let me pull that up...")

Customer **never sees raw JSON** even on parser failure.

### Gemini quirks

- Model: `gemini-3-pro-preview` (override via `GEMINI_MODEL` env)
- **Thinking mode burns 1500–3000 tokens before any visible output.** The default `maxOutputTokens` is 8000 to leave ~5000 for the JSON. Lower caps cause silent truncation and trigger the regex fallback in the parser.
- Timeout is 35s. Real production replies usually take 6–10s end-to-end (most of it Gemini).
- System prompt is `ANANDITA_SYSTEM_PROMPT` in `gemini_chat.ts`, but is **runtime-overridable** via `bot_settings.system_prompt` in Supabase (live editable through `/api/chat-history?view=edit-prompt`). Resolution: DB → fallback to hardcoded.
- `finishReason` is logged whenever it's not `STOP` — watch for `MAX_TOKENS` / `SAFETY` in Vercel logs.

### Knowledge sources (the bot's PROJECT_CONTEXT)

Three distinct stores, kept separate so they can be edited independently without cross-overwrite:

| Field | Purpose | Updated via |
|------|---------|-------------|
| `project_facts.kb_text`           | Big static KB (overview, location, amenities, specs) — auto-extracted from uploaded TXT/PDF. | Section 5 KB upload in dashboard. |
| `project_facts.facts_text`        | Curated **OFFER details** only — rental scheme, pre-EMI, limited deals.                   | Section 1B "Edit ✎" form.       |
| Inventory Google Sheet            | Live unit availability + per-sft + all-inclusive + offer column.                          | Direct edit on the master sheet (5-min cache). |

Older code paths (and earlier commits) used `facts_text` for both — uploads would silently overwrite the offer text. The split is enforced by `saveProjectKb()` in `api/_utils/project_facts.ts`, which `PATCH`es only the kb_text columns.

### Document delivery (PDFs over WhatsApp)

`project_documents` table (Supabase) holds rows with `(project, doc_type, size_label?, url, filename)`. The bot's `doc_to_send` field selects a `doc_type`:

- Single-slot doc types: `master_plan, price_sheet, payment_structure, brochure, specifications, amenities`
- Multi-slot doc types: `floor_plan` (per-tower), `unit_plan` (per-unit-size). The dispatcher in `api/_utils/document_dispatcher.ts` does fuzzy matching on `size_label` against the customer's message.

Uploads use the signed-URL flow (browser → Supabase Storage direct). Section 5 of the dashboard renders the per-project upload UI.

### Outbound voice (in-house Anandita bot)

```
Zoho Deluge button     → POST /api/relay/inhouse-call    { _zoho_lead_id, phone_number }
                         ↓ Bearer ASBL_VOICEBOT_API_KEY
                       voice-bot /api/trigger-call (Plivo dial)
                         ↓ (call happens)
                       voice-bot fires call_completed webhook
                         ↓ X-Webhook-Secret = INHOUSE_POSTHOOK_SECRET
api/relay/inhouse-posthook → lookup lead by Last_Inhouse_Call_ID (or phone fallback)
                            → updateLead, blueprint transition, Zoho Note + Call log
```

Voice-bot's `call_completed` payload has `started_at` + `ended_at` (no `duration_seconds`) and uses `call_outcome` for status (not `call_result_slug` — that was Arrowhead). Both are handled in the receiver.

`Last_Inhouse_Call_ID` is an **optional** Zoho custom field. If absent, lookup falls back to `findLeadByPhone` — works but ambiguous when the same phone has multi-project lead records.

## Required SQL migrations

The repo has no migration framework — schema changes are documented in `SQL_TO_RUN.md` and run manually in Supabase SQL Editor. Cumulative state required for the current code to work:

```sql
-- Multi-slot per-tower / per-size docs
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS size_label TEXT;
CREATE INDEX IF NOT EXISTS idx_project_documents_size
  ON project_documents(project, doc_type, size_label);

-- KB / offer split (so KB upload doesn't wipe the manually-curated offer text)
ALTER TABLE project_facts ADD COLUMN IF NOT EXISTS kb_text TEXT;
ALTER TABLE project_facts ADD COLUMN IF NOT EXISTS kb_updated_at TIMESTAMPTZ;
ALTER TABLE project_facts ADD COLUMN IF NOT EXISTS kb_pdf_url TEXT;

-- Live editable bot prompt + cached Zoho token
CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Environment variables (Vercel)

All set on **Production** scope (most also on Preview). Grouped by integration:

| Group | Vars |
|------|------|
| Supabase | `SUPABASE_URL`, `SUPABASE_SECRET_KEY` |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL` (defaults to `gemini-3-pro-preview`) |
| Zoho | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` |
| Periskope (WhatsApp) | `PERISKOPE_API_KEY` |
| Meta Lead Ads | `META_PAGE_ACCESS_TOKEN` (must be System User permanent token), `META_VERIFY_TOKEN`, `META_FORM_IDS_ALLOWLIST` |
| In-house voice bot | `ASBL_VOICEBOT_URL`, `ASBL_VOICEBOT_API_KEY`, `INHOUSE_POSTHOOK_SECRET` |
| Anandita LLM (legacy fallback) | `ANANDITA_URL`, `ANANDITA_API_KEY`, `ANANDITA_INTENT_URL` |
| Lazybot | `LAZYBOT_URL`, `LAZYBOT_API_KEY`, `LAZYBOT_SESSION_ID` |
| Dual-run fan-out to new Intelligent CRM | `NEW_CRM_INGEST_URL` (= `https://intelligent-crm-api.vercel.app`), `NEW_CRM_INGEST_SECRET` (= the new CRM's `INGEST_SECRET`). Both must be set to START the parallel run; unset either to STOP it. Drives `api/_utils/fanout_new_crm.ts` — every successfully-ingested lead is best-effort forwarded to `${NEW_CRM_INGEST_URL}/api/ingest/<source>` so it appears in BOTH systems. Inert (silent no-op) until both are set. |

## Useful debug + ops endpoints

```
GET  /api/chat-history?view=dashboard
GET  /api/chat-history?view=edit-prompt          # Live system-prompt editor
GET  /api/chat-history?view=edit-facts&project=X # Per-project offer text editor
POST /api/chat-history?action=test-gemini        # Sandbox call to Gemini using
                                                   a project's PROJECT_CONTEXT —
                                                   no Periskope/Zoho side effects.
GET  /api/chat-history?action=meta-token-check   # Validates META_PAGE_ACCESS_TOKEN
GET  /api/chat-history?action=zoho-lead&id=X&secret=$INHOUSE_POSTHOOK_SECRET
                                                 # Lead state + last 5 Notes + Calls
POST /api/chat-history?action=upload-sign        # Signed Supabase Storage PUT URL
POST /api/chat-history?action=upload-finalize    # Records uploaded file + extracts KB text
POST /api/chat-history?action=save-prompt        # Live update of bot system prompt
POST /api/chat-history?action=refresh-inventory  # Manual inventory cache flush
```

## Conventions

- Hindi/Hinglish in user-facing strings (commit messages, console errors) is fine — **never** in code identifiers or file paths.
- Webhook handlers should return 200 quickly (within Vercel's serverless time budget) but must `await` writes — see "Awaiting in serverless" above.
- Always grep for `Last_Arrowhead_Call_ID` before claiming Arrowhead is fully gone — `cron/followup.ts` and a couple of utility helpers may still mention it.
- Periskope round-robin uses 10 sender numbers; never hardcode a single sender.
- The bot persona ("Anandita") is the same across WhatsApp (this repo) and outbound voice (the in-house voice bot repo at `https://bitbucket.org/angadchatbot/asbl-voice-bot`). Keep persona/voice consistent if changing prompts.

## Reference docs already in repo

- `ASBL_CRM_System_Documentation.md` — overall product/CRM system overview
- `ASBL_CRM_Context.md` — business context
- `INGESTION_LOGIC.md` — how leads flow in
- `zoho-deluge-functions.md` — the Zoho-side Deluge functions
- `SQL_TO_RUN.md` — pending Supabase migrations
