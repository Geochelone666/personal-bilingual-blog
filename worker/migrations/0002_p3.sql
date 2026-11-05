-- P3: privacy-friendly page views (no IP, no cookies) and weekly task bookkeeping.
CREATE TABLE IF NOT EXISTS page_views (day TEXT NOT NULL, path TEXT NOT NULL, referrer TEXT NOT NULL DEFAULT '', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path, referrer));
CREATE TABLE IF NOT EXISTS periodic_runs (name TEXT PRIMARY KEY, last_key TEXT NOT NULL, at TEXT NOT NULL);
