// P3: page-view counter, stats digest, weekly content backup.
import type { Env } from "./env";
import { GitHub } from "./github";
import { Telegram } from "./telegram";
import { nowIso } from "./util";

const SITE_HOST = "personal-bilingual-blog.pages.dev";

/** Normalise a blog path; returns null for anything that isn't one of our pages. */
export function cleanPath(p: string | null): string | null {
  if (!p || p.length > 200 || !p.startsWith("/")) return null;
  const path = p.split(/[?#]/)[0];
  if (!/^\/(zh|en)\/([a-z0-9-]+\/)*$/.test(path) && path !== "/") return null;
  return path;
}

export function cleanReferrer(r: string | null): string {
  const h = (r ?? "").toLowerCase().replace(/^www\./, "").slice(0, 80);
  if (!h || h === SITE_HOST || h.endsWith(`.${SITE_HOST}`)) return "";
  return /^[a-z0-9.-]+$/.test(h) ? h : "";
}

const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|embedly|curl|wget|python|httpclient|axios|node-fetch|go-http/i;
export function isBot(ua: string | null): boolean {
  return !ua || BOT_UA.test(ua);
}

export async function recordHit(env: Env, url: URL, req?: Request): Promise<Response> {
  const path = cleanPath(url.searchParams.get("p"));
  const h = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  if (!path) return new Response(null, { status: 204, headers: h });
  if (req && isBot(req.headers.get("User-Agent"))) return new Response(null, { status: 204, headers: h });
  const day = new Date().toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO page_views (day, path, referrer, n) VALUES (?,?,?,1) ON CONFLICT(day, path, referrer) DO UPDATE SET n=n+1")
    .bind(day, path, cleanReferrer(url.searchParams.get("r"))).run();
  return new Response(null, { status: 204, headers: h });
}

type F = typeof fetch;

export async function collectStats(env: Env, days = 7, f: F = fetch): Promise<string> {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const lines: string[] = [`📊 近 ${days} 天数据（${since} 起）`];
  try {
    const tot = await env.DB.prepare("SELECT COALESCE(SUM(n),0) n FROM page_views WHERE day>=?").bind(since).first<any>();
    lines.push(`\n博客浏览：${tot?.n ?? 0} 次（已过滤机器人，同一会话同页只计一次）`);
    const top = await env.DB.prepare("SELECT path, SUM(n) n FROM page_views WHERE day>=? AND path LIKE '%/posts/%' GROUP BY path ORDER BY n DESC LIMIT 5").bind(since).all<any>();
    for (const r of top.results ?? []) lines.push(`· ${r.path.replace(/^\/(zh|en)\/posts\//, "$1 ").replace(/\/$/, "")}：${r.n}`);
    const refs = await env.DB.prepare("SELECT referrer, SUM(n) n FROM page_views WHERE day>=? AND referrer!='' GROUP BY referrer ORDER BY n DESC LIMIT 5").bind(since).all<any>();
    if (refs.results?.length) lines.push(`来源：${refs.results.map((r: any) => `${r.referrer} ${r.n}`).join("，")}`);
  } catch (e: any) {
    lines.push(`\n博客浏览：读取失败（${String(e?.message ?? e).slice(0, 60)}）`);
  }

  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  const subs: string[] = [];
  for (const [label, ch] of [["中文频道", env.TELEGRAM_CHANNEL], ["英文频道", env.TELEGRAM_CHANNEL_EN]] as const) {
    if (!ch) continue;
    try { subs.push(`${label} ${await tg.call("getChatMemberCount", { chat_id: ch.startsWith("@") || ch.startsWith("-") ? ch : `@${ch}` })}`); } catch { subs.push(`${label} 未知`); }
  }
  if (subs.length) lines.push(`\nTelegram 订阅：${subs.join("，")}`);

  if (env.DEVTO_API_KEY) {
    try {
      const r = await f("https://dev.to/api/articles/me/published?per_page=100", { headers: { "api-key": env.DEVTO_API_KEY, "User-Agent": "pbb-writer", Accept: "application/vnd.forem.api-v1+json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const list: any[] = await r.json();
      const v = list.reduce((a, x) => a + (x.page_views_count ?? 0), 0), re = list.reduce((a, x) => a + (x.public_reactions_count ?? 0), 0), c = list.reduce((a, x) => a + (x.comments_count ?? 0), 0);
      lines.push(`dev.to（累计）：${list.length} 篇，浏览 ${v}，点赞 ${re}，评论 ${c}`);
    } catch (e: any) { lines.push(`dev.to：读取失败（${String(e?.message ?? e).slice(0, 40)}）`); }
  }
  if (env.BLUESKY_HANDLE) {
    try {
      const r = await f(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(env.BLUESKY_HANDLE)}&limit=50&filter=posts_no_replies`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const feed: any[] = ((await r.json()) as any).feed ?? [];
      const own = feed.filter((x) => !x.reason);
      const sum = (k: string) => own.reduce((a, x) => a + (x.post?.[k] ?? 0), 0);
      const pr = await f(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(env.BLUESKY_HANDLE)}`);
      if (!pr.ok) throw new Error(`HTTP ${pr.status}`);
      const prof: any = await pr.json();
      lines.push(`Bluesky（累计）：关注者 ${prof.followersCount ?? "?"}，${own.length} 帖，赞 ${sum("likeCount")}，转发 ${sum("repostCount")}，回复 ${sum("replyCount")}`);
    } catch (e: any) { lines.push(`Bluesky：读取失败（${String(e?.message ?? e).slice(0, 40)}）`); }
  }
  lines.push("Medium：无公开接口，见 medium.com/me/stats");
  return lines.join("\n");
}

/** Public content only: no Telegram ids, chat state or usage logs (the repo is public). */
export async function buildBackup(env: Env): Promise<string> {
  const articles = await env.DB.prepare("SELECT id, slug, kind, category, status, current_version_id, first_published_at, created_at, updated_at FROM articles WHERE status!='discarded' ORDER BY created_at").all<any>();
  const versions = await env.DB.prepare("SELECT id, article_id, version_no, title_zh, body_zh, zh_hash, title_en, body_en, en_hash, en_source, created_at FROM versions ORDER BY article_id, version_no").all<any>();
  const jobs = await env.DB.prepare("SELECT article_id, platform, status, stage, public_urls, updated_at FROM publish_jobs ORDER BY article_id, platform").all<any>();
  const glossary = await env.DB.prepare("SELECT * FROM glossary").all<any>().catch(() => ({ results: [] as any[] }));
  return JSON.stringify({ articles: articles.results, versions: versions.results, publish_jobs: jobs.results, glossary: glossary.results }, null, 1) + "\n";
}

/** Run `fn` once per key (e.g. ISO week). Returns true when it ran. */
async function once(env: Env, name: string, key: string, fn: () => Promise<void>): Promise<boolean> {
  const row = await env.DB.prepare("SELECT last_key FROM periodic_runs WHERE name=?").bind(name).first<any>();
  if (row?.last_key === key) return false;
  await fn();
  await env.DB.prepare("INSERT INTO periodic_runs (name, last_key, at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET last_key=excluded.last_key, at=excluded.at").bind(name, key, nowIso()).run();
  return true;
}

/** Wall-clock parts in America/Toronto (handles EST/EDT). */
export function torontoParts(d: Date): { y: number; m: number; day: number; hour: number; weekday: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, day: +p.day, hour: +p.hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

export function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((+t - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** Called every minute; runs the weekly jobs once on Monday from 09:00 America/Toronto (EST or EDT). */
export async function weekly(env: Env, now = new Date()) {
  const t = torontoParts(now);
  if (t.weekday !== 1 || t.hour < 9) return;
  const key = weekKey(new Date(Date.UTC(t.y, t.m - 1, t.day)));
  await once(env, "backup", key, async () => {
    const gh = new GitHub(env.GITHUB_TOKEN, env.GITHUB_REPO);
    const content = await buildBackup(env);
    if ((await gh.getFileText("backup/content.json", env.GITHUB_BRANCH)) === content) return; // unchanged: no empty commit
    await gh.commitFiles(env.GITHUB_BRANCH, [{ path: "backup/content.json", content }], `backup: content ${key}`);
  });
  const owner = Number((env.ALLOWED_TELEGRAM_USER_IDS || "").split(",")[0]);
  if (owner) await once(env, "stats_digest", key, async () => { await new Telegram(env.TELEGRAM_BOT_TOKEN).send(owner, await collectStats(env, 7)); });
}
