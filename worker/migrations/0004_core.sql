-- Core hardening (2026-11-05). Additive only.
ALTER TABLE publish_jobs ADD COLUMN lease_until TEXT;      -- a worker owns the job until this time
ALTER TABLE seen_updates ADD COLUMN status TEXT NOT NULL DEFAULT 'done'; -- pending | done | failed
ALTER TABLE seen_updates ADD COLUMN payload TEXT;          -- kept only while pending
ALTER TABLE seen_updates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE articles ADD COLUMN source_update INTEGER;     -- Telegram update that created it (replay guard)
CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_source_update ON articles(source_update) WHERE source_update IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_updates_status ON seen_updates(status, at);
CREATE INDEX IF NOT EXISTS idx_jobs_article_platform ON publish_jobs(article_id, platform, created_at);
