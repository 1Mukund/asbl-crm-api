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

That's it. Run once.
