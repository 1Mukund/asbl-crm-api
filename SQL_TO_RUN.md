# SQL to run in Supabase before deploying prompt-editor + signed-upload changes

```sql
-- Bot-level settings (currently used for: editable Gemini system prompt)
CREATE TABLE IF NOT EXISTS bot_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

That's it. Run once.
