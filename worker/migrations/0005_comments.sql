-- Reader comments (2026-11-11). Anyone can comment, nickname optional, no approval.
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site TEXT NOT NULL,            -- 'prod' | 'test' (staging/preview comments never show on the live blog)
  slug TEXT NOT NULL,            -- post slug, shared by zh and en pages
  name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  ip_hash TEXT NOT NULL,         -- salted hash, only for rate limiting
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments(site, slug, deleted, id);
CREATE INDEX IF NOT EXISTS idx_comments_ip ON comments(ip_hash, created_at);
