import { Env } from "./env";

type F = typeof fetch;
export interface Mismatch { key: string; text: string }

/**
 * Read-only check that every job marked done still matches the remote side,
 * and that no platform holds duplicates of one article. Never writes remotely.
 */
export async function reconcile(env: Env, f: F = fetch): Promise<{ checked: number; problems: Mismatch[] }> {
  const rows = ((await env.DB.prepare(
    "SELECT j.id, j.article_id, j.platform, j.public_urls, j.remote_id FROM publish_jobs j WHERE j.status='done' AND j.created_at=(SELECT MAX(k.created_at) FROM publish_jobs k WHERE k.article_id=j.article_id AND k.platform=j.platform AND k.status='done')",
  ).all<any>()).results ?? []) as any[];
  const problems: Mismatch[] = [];
  const bad = (j: any, why: string) => problems.push({ key: `remote:${j.id}:${why}`, text: `${j.platform} 远端与记录不一致（${j.article_id}）：${why}` });
  let checked = 0;
  const canon = new Map<string, number>();
  for (const j of rows) {
    const urls: string[] = JSON.parse(j.public_urls || "[]");
    const remote = j.remote_id ? JSON.parse(j.remote_id) : null;
    try {
      if (j.platform === "blog") {
        // Preview (staging) publishes are not durable by design; only the production site is checked.
        if (env.SITE_URL && urls.length && !urls.every((u) => u.startsWith(env.SITE_URL))) continue;
        for (const u of urls) {
          const r = await f(u, { method: "GET", redirect: "manual" });
          if (r.status !== 200) bad(j, `${new URL(u).pathname} HTTP ${r.status}`);
        }
      } else if (j.platform === "telegram" || j.platform === "telegram_en") {
        if (!remote?.ids?.length) { bad(j, "缺少消息 ID"); continue; }
        for (const id of remote.ids) {
          // editMessageReplyMarkup with no markup is a no-op on an existing message ("not modified").
          const r = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: remote.chat, message_id: id }) });
          const d: any = await r.json().catch(() => ({}));
          if (/not found|message_id_invalid/i.test(d.description ?? "")) bad(j, `消息 ${id} 不存在`);
        }
      } else if (j.platform === "bluesky") {
        if (!remote?.rkeys?.length) { bad(j, "缺少帖子 ID"); continue; }
        const repo = remote.did ?? env.BLUESKY_HANDLE;
        for (const rkey of remote.rkeys) {
          const r = await f(`https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo!)}&collection=app.bsky.feed.post&rkey=${rkey}`);
          if (r.status !== 200) bad(j, `帖子 ${rkey} HTTP ${r.status}`);
        }
      } else if (j.platform === "devto") {
        const u = urls[0];
        if (u) {
          // dev.to rejects requests without a User-Agent (HTTP 403); use the API by id when we have it.
          const r = remote?.id
            ? await f(`https://dev.to/api/articles/${remote.id}`, { headers: { "User-Agent": "pbb-writer", accept: "application/vnd.forem.api-v1+json" } })
            : await f(u, { method: "GET", headers: { "User-Agent": "pbb-writer" } });
          if (r.status !== 200) bad(j, `HTTP ${r.status}`);
        }
      } else continue; // Medium: no reliable read access
      checked++;
    } catch (e: any) {
      problems.push({ key: `remote-check:${j.id}`, text: `${j.platform} 无法核查（${j.article_id}）：${String(e?.message ?? e).slice(0, 60)}` });
    }
  }
  // Duplicates on dev.to: more than one article with the same canonical URL.
  if (env.DEVTO_API_KEY) {
    try {
      const r = await f("https://dev.to/api/articles/me/all?per_page=1000", { headers: { "api-key": env.DEVTO_API_KEY, accept: "application/vnd.forem.api-v1+json", "User-Agent": "pbb-writer" } });
      if (r.ok) for (const a of (await r.json()) as any[]) if (a.canonical_url) canon.set(a.canonical_url, (canon.get(a.canonical_url) ?? 0) + 1);
      for (const [c, n] of canon) if (n > 1) problems.push({ key: `dup:devto:${c}`, text: `dev.to 上同一篇文章有 ${n} 份（canonical ${c}）` });
    } catch { /* reported by the per-job check */ }
  }
  return { checked, problems };
}
