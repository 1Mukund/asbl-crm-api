# SQL to run in Supabase before deploying prompt-editor + signed-upload changes

```sql
-- PDF text-extract fallback KB (run before deploying PDF-extract feature)
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS text_extract TEXT;
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS text_extract_chars INTEGER;
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS text_extracted_at TIMESTAMPTZ;
```



```sql
-- Bot-level settings (currently used for: editable Gemini system prompt)
CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```


# v5 chatbot upgrade — user memory + strict doc lookup + offer urgency

Run these once in Supabase before deploying the v5 chatbot code.

```sql
-- 1. user_profiles — per-phone structured memory built up from extracted_facts
--    in every Gemini reply. Read on every inbound, merged on every outbound.
CREATE TABLE IF NOT EXISTS user_profiles (
  phone                 TEXT PRIMARY KEY,
  name                  TEXT,
  budget_cr             NUMERIC(10,2),
  intent                TEXT,          -- investment | end_use | exploration | rental_yield | resale
  preferred_size_sft    INTEGER,
  preferred_bhk         NUMERIC(3,1),  -- 2 / 2.5 / 3 / 3.5 / 4
  preferred_facing      TEXT,          -- east | west | north | south | north_east | ...
  family_size           INTEGER,
  work_location         TEXT,          -- "Gachibowli" / "Financial District" / ...
  timeline              TEXT,          -- "3 months" / "6 months" / "1 year" / ...
  objections_raised     TEXT[] DEFAULT ARRAY[]::TEXT[],
  commitments_made      TEXT[] DEFAULT ARRAY[]::TEXT[],
  docs_sent             TEXT[] DEFAULT ARRAY[]::TEXT[],
  preferred_language    TEXT,          -- english | hindi | hinglish | telugu
  current_project       TEXT,          -- LOFT | SPECTRA | BROADWAY | LANDMARK | LEGACY
  last_project          TEXT,
  last_interaction_at   TIMESTAMPTZ,
  funnel_stage          TEXT NOT NULL DEFAULT 'new',
                                       -- new | engaged | qualified | brochure_sent
                                       -- | cost_sheet_sent | visit_scheduled | visit_done
                                       -- | negotiating | booked | lost
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_funnel ON user_profiles(funnel_stage);
CREATE INDEX IF NOT EXISTS idx_user_profiles_project ON user_profiles(current_project);
```

```sql
-- 2. project_documents — strict-equality columns for doc_meta lookups.
--    The bot's reply JSON includes { unit_size_sft, facing, tower } so we can
--    look up the EXACT PDF instead of fuzzy-matching size_label text.
--    Existing rows still work — these are added alongside size_label and the
--    dispatcher only uses the new int/enum cols when the bot supplied a meta.
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS unit_size_sft INTEGER;
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS facing TEXT;       -- east | west | north | south | north_east | ...
ALTER TABLE project_documents ADD COLUMN IF NOT EXISTS tower TEXT;        -- "A" / "B" / "1" / "Tower-A" canonical text

CREATE INDEX IF NOT EXISTS idx_project_documents_strict_lookup
  ON project_documents(project, doc_type, unit_size_sft, facing, tower);
```

```sql
-- 3. project_facts — offer expiry date (powers OFFER_TIME_REMAINING injection)
ALTER TABLE project_facts ADD COLUMN IF NOT EXISTS offer_end_at TIMESTAMPTZ;
```

```sql
-- 4. doc_send_log — every doc-send attempt (passed AND blocked) for audit.
--    Lets us debug "why did the wrong PDF go" and "why didn't a PDF go".
CREATE TABLE IF NOT EXISTS doc_send_log (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  phone          TEXT NOT NULL,
  project        TEXT,
  doc_type       TEXT,
  doc_meta       JSONB,                -- { unit_size_sft, facing, tower }
  matched_url    TEXT,
  matched_file   TEXT,
  reply_text     TEXT,
  outcome        TEXT NOT NULL,        -- sent | blocked_mismatch | blocked_not_found | error
  block_reason   TEXT,
  sizes_in_reply INTEGER[]             -- e.g. [1695] — sizes parsed from reply text
);

CREATE INDEX IF NOT EXISTS idx_doc_send_log_phone_time
  ON doc_send_log(phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_doc_send_log_outcome_time
  ON doc_send_log(outcome, created_at DESC);
```

After running the migrations, **backfill** the new `project_documents` columns from
existing `size_label` text once. A migration helper to do this is exposed at
`/api/chat-history?action=backfill-doc-meta` (admin-only — see route for the
secret). Until backfilled, the strict lookup will fail for older PDFs and the
dispatcher will return `ERROR_NOT_FOUND`, which the bot handles gracefully ("let
me confirm with the team").
