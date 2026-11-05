// Rebuild D1 rows from the PUBLIC backup (backup/content.json) when the database itself is lost
// beyond Time Travel's 30-day window. Recovers published content only (by design the backup has no drafts).
// Usage: node scripts/backup-to-sql.mjs ../backup/content.json > restore.sql ; apply migrations first, then restore.sql.
import { readFileSync } from "node:fs";
const b = JSON.parse(readFileSync(process.argv[2], "utf8"));
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const now = new Date().toISOString();
const out = [];
for (const a of b.articles) {
  out.push(`INSERT OR IGNORE INTO articles (id, slug, status, current_version_id, published_version_id, created_by, created_at, updated_at, first_published_at, kind, category) VALUES (${[a.id, a.slug, "published", a.published_version_id, a.published_version_id, 0, a.first_published_at, now, a.first_published_at, a.kind ?? "article", a.category ?? null].map(lit).join(",")});`);
}
for (const v of b.versions) {
  out.push(`INSERT OR IGNORE INTO versions (id, article_id, version_no, title_zh, body_zh, zh_hash, title_en, body_en, en_hash, en_source, translation_status, created_at) VALUES (${[v.id, v.article_id, v.version_no, v.title_zh, v.body_zh, v.zh_hash, v.title_en, v.body_en, v.en_hash, "restored", "done", v.created_at].map(lit).join(",")});`);
}
console.log(out.join("\n"));
console.error(`articles ${b.articles.length}, versions ${b.versions.length} (publish job history is informational and not restored)`);
