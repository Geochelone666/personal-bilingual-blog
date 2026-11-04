-- personal-bilingual-blog P0 schema (Cloudflare D1 / SQLite)
-- Chinese is the only authoritative source. Every edit creates a new immutable version.

CREATE TABLE IF NOT EXISTS articles (
  id            TEXT PRIMARY KEY,            -- e.g. a_20261104_xxxx
  slug          TEXT NOT NULL UNIQUE,        -- stable URL slug, never reused
  status        TEXT NOT NULL,               -- draft | translating | translation_failed | translation_paused | in_review | approved | publishing | published | publish_failed | discarded
  current_version_id TEXT,
  published_version_id TEXT,
  first_published_at TEXT,                   -- set once, keeps post date stable on updates
  created_by    INTEGER NOT NULL,            -- telegram user id
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
  id            TEXT PRIMARY KEY,
  article_id    TEXT NOT NULL REFERENCES articles(id),
  version_no    INTEGER NOT NULL,
  title_zh      TEXT NOT NULL,
  body_zh       TEXT NOT NULL,
  zh_hash       TEXT NOT NULL,               -- sha256(title_zh \n body_zh)
  title_en      TEXT,
  body_en       TEXT,
  en_hash       TEXT,                        -- sha256(title_en \n body_en), null until translated
  en_source     TEXT,                        -- deepl | cache | user_edit
  translation_status TEXT NOT NULL,          -- pending | done | failed | paused_quota
  translation_error TEXT,
  qc_json       TEXT,                        -- algorithmic QC report
  created_at    TEXT NOT NULL,
  UNIQUE (article_id, version_no)
);

-- Content-hash translation cache: same Chinese + same glossary => no re-translation.
CREATE TABLE IF NOT EXISTS translation_cache (
  cache_key     TEXT PRIMARY KEY,            -- sha256(zh_hash | glossary_hash | engine)
  title_en      TEXT NOT NULL,
  body_en       TEXT NOT NULL,
  engine        TEXT NOT NULL,
  chars_billed  INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS glossary (
  term_zh       TEXT PRIMARY KEY,
  term_en       TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- An approval binds: exact version, zh hash, en hash and the target platform list.
CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  article_id    TEXT NOT NULL REFERENCES articles(id),
  version_id    TEXT NOT NULL REFERENCES versions(id),
  zh_hash       TEXT NOT NULL,
  en_hash       TEXT NOT NULL,
  platforms     TEXT NOT NULL,               -- JSON array, sorted, e.g. ["blog"]
  approval_hash TEXT NOT NULL UNIQUE,        -- sha256(version_id|zh_hash|en_hash|platforms)
  approved_by   INTEGER NOT NULL,
  approved_at   TEXT NOT NULL,
  invalidated_at TEXT,
  invalidated_reason TEXT
);

-- One job per (article, platform, approval). Retries reuse the same row.
CREATE TABLE IF NOT EXISTS publish_jobs (
  id            TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,      -- article_id|platform|approval_hash
  article_id    TEXT NOT NULL REFERENCES articles(id),
  approval_id   TEXT NOT NULL REFERENCES approvals(id),
  platform      TEXT NOT NULL,
  stage         TEXT NOT NULL,               -- last completed step: queued | committed | deployed | verified
  status        TEXT NOT NULL,               -- active | failed | cancelled | done
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  commit_sha    TEXT,
  deployment_id TEXT,
  deployment_url TEXT,
  public_urls   TEXT,                        -- JSON array of verified URLs
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Append-only receipts for every stage of every job.
CREATE TABLE IF NOT EXISTS publish_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id        TEXT NOT NULL,
  stage         TEXT NOT NULL,               -- github_commit | pages_deploy | url_verify | error | retry
  ok            INTEGER NOT NULL,
  detail        TEXT,
  at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,               -- deepl
  chars         INTEGER NOT NULL,
  article_id    TEXT,
  detail        TEXT,
  at            TEXT NOT NULL
);

-- Per-user conversation state for the bot (e.g. waiting for an edited text).
CREATE TABLE IF NOT EXISTS chat_state (
  user_id       INTEGER PRIMARY KEY,
  mode          TEXT NOT NULL,               -- idle | collect_new | edit_zh | edit_en
  article_id    TEXT,
  buffer        TEXT,                        -- multi-message draft being collected (/new ... /done)
  updated_at    TEXT NOT NULL
);

-- Telegram update de-duplication (Telegram may redeliver webhooks).
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id     INTEGER PRIMARY KEY,
  at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versions_article ON versions(article_id, version_no);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON publish_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_approvals_article ON approvals(article_id);
