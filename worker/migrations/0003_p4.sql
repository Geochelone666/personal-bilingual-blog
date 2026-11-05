-- P4: content kind, category, user-selected targets, covers, per-platform drafts bound into approvals.
ALTER TABLE articles ADD COLUMN kind TEXT NOT NULL DEFAULT 'article';         -- article | quick
ALTER TABLE articles ADD COLUMN category TEXT;                                -- dev | ai | finance | politics | essay
ALTER TABLE articles ADD COLUMN targets TEXT;                                 -- JSON array chosen by the user (null = recommendation)
ALTER TABLE articles ADD COLUMN cover_file_id TEXT;                           -- custom cover (Telegram file id)
ALTER TABLE articles ADD COLUMN cover_sha TEXT;                               -- sha256 of the custom cover bytes
ALTER TABLE articles ADD COLUMN review_sent_for TEXT;                         -- version id + targets hash the last review card was sent for
ALTER TABLE approvals ADD COLUMN drafts_json TEXT;                            -- exact per-platform content that was approved
ALTER TABLE approvals ADD COLUMN drafts_hash TEXT;
ALTER TABLE publish_jobs ADD COLUMN remote_id TEXT;                           -- platform-side id(s)
ALTER TABLE publish_jobs ADD COLUMN content_hash TEXT;                        -- hash of the draft this job published (sync detection)
CREATE TABLE IF NOT EXISTS channel_cursor (chat TEXT PRIMARY KEY, last_message_id INTEGER NOT NULL, at TEXT NOT NULL);
