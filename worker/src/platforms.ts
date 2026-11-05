/** Cross-posting adapters (P1). Each returns the public URL of the post it made (or found). */
import { Env } from "./env";

export interface PostInput {
  articleId: string;
  titleZh: string;
  bodyZh: string;
  titleEn: string;
  bodyEn: string;
  zhUrl: string;
  enUrl: string;
}
type F = typeof fetch;

export const PLATFORM_LABEL: Record<string, string> = { blog: "博客", telegram: "Telegram 中文频道", telegram_en: "Telegram 英文频道", devto: "dev.to", bluesky: "Bluesky" };
export const PLATFORM_ORDER = ["blog", "telegram", "telegram_en", "devto", "bluesky"];

/** A platform is enabled when it is listed in ENABLED_PLATFORMS and its credentials exist. */
export function enabledPlatforms(env: Env): string[] {
  const listed = (env.ENABLED_PLATFORMS || "blog").split(",").map((s) => s.trim()).filter(Boolean);
  const ready: Record<string, boolean> = {
    blog: true,
    telegram: !!env.TELEGRAM_CHANNEL,
    telegram_en: !!env.TELEGRAM_CHANNEL_EN,
    devto: !!env.DEVTO_API_KEY,
    bluesky: !!env.BLUESKY_HANDLE && !!env.BLUESKY_APP_PASSWORD,
  };
  const out = PLATFORM_ORDER.filter((p) => listed.includes(p) && ready[p]);
  return out.includes("blog") ? out : ["blog", ...out];
}

function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function cut(s: string, n: number): string {
  const c = [...s];
  return c.length > n ? c.slice(0, n - 1).join("") + "…" : s;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------- Telegram channel ----------------
/** Markdown (the subset we write) -> Telegram HTML. */
export function mdToTgHtml(md: string): string {
  const blocks: string[] = [];
  md = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => `\u0000${blocks.push(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`) - 1}\u0000`);
  let out = esc(md);
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>").replace(/^&gt;\s?/gm, "▎").replace(/^\s*[-*]\s+/gm, "• ");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[+i]).replace(/\n{3,}/g, "\n\n").trim();
}

/** Split HTML text on paragraph boundaries into chunks under the Telegram limit. */
export function splitForTelegram(html: string, limit = 3900): string[] {
  const paras = html.split("\n\n");
  const out: string[] = [];
  let cur = "";
  for (const p of paras) {
    const pieces = p.length > limit ? p.match(new RegExp(`[\\s\\S]{1,${limit}}`, "g"))! : [p];
    for (const piece of pieces) {
      if (cur && cur.length + 2 + piece.length > limit) { out.push(cur); cur = piece; }
      else cur = cur ? `${cur}\n\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** One language per channel: full text + link to that language's blog page. */
export function telegramMessages(p: PostInput, lang: "zh" | "en"): string[] {
  const html =
    lang === "zh"
      ? `<b>${esc(p.titleZh)}</b>\n\n${mdToTgHtml(p.bodyZh)}\n\n<a href="${esc(p.zhUrl)}">博客原文</a>`
      : `<b>${esc(p.titleEn)}</b>\n\n${mdToTgHtml(p.bodyEn)}\n\n<a href="${esc(p.enUrl)}">Read on the blog</a>`;
  return splitForTelegram(html);
}

export interface Progress { state: string | null; save(state: string): Promise<void>; }

export async function postTelegram(env: Env, p: PostInput, f: F, prog?: Progress, lang: "zh" | "en" = "zh"): Promise<string> {
  const tc = (lang === "zh" ? env.TELEGRAM_CHANNEL : env.TELEGRAM_CHANNEL_EN) ?? "";
  const chan = tc.startsWith("@") || tc.startsWith("-") ? tc : `@${tc}`;
  const msgs = telegramMessages(p, lang);
  // Resume after a partial failure: state = JSON {sent:n, first:url}
  const st: { sent: number; first?: string } = prog?.state ? JSON.parse(prog.state) : { sent: 0 };
  for (let i = st.sent; i < msgs.length; i++) {
    const r = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chan, text: msgs[i], parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram 频道发送失败：${j.description ?? r.status}`);
    const user = j.result?.chat?.username;
    const url = user ? `https://t.me/${user}/${j.result.message_id}` : `https://t.me/c/${String(j.result.chat.id).replace(/^-100/, "")}/${j.result.message_id}`;
    st.sent = i + 1;
    st.first ??= url;
    await prog?.save(JSON.stringify(st));
  }
  return st.first!;
}

// ---------------- dev.to ----------------
export async function postDevto(env: Env, p: PostInput, f: F): Promise<string> {
  const h: Record<string, string> = { "api-key": env.DEVTO_API_KEY ?? "", "Content-Type": "application/json", Accept: "application/vnd.forem.api-v1+json", "User-Agent": "pbb-writer" };
  // Idempotency: an article with this canonical URL already exists -> reuse it.
  const mine = await f("https://dev.to/api/articles/me/all?per_page=100", { headers: h });
  if (mine.ok) {
    const list: any[] = await mine.json();
    const hit = list.find((a) => a.canonical_url === p.enUrl);
    if (hit?.url) return hit.url;
  } else if (mine.status === 401) throw new Error("dev.to API 密钥无效");
  const body = `${p.bodyEn}\n\n---\n*Originally published at [${new URL(p.enUrl).host}](${p.enUrl}). Written in Chinese, translated to English.*`;
  const r = await f("https://dev.to/api/articles", {
    method: "POST",
    headers: h,
    body: JSON.stringify({ article: { title: p.titleEn, body_markdown: body, published: true, canonical_url: p.enUrl, tags: ["blog", "writing"] } }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`dev.to 发布失败：HTTP ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return j.url;
}

// ---------------- Bluesky ----------------
const PDS = "https://bsky.social/xrpc";
export async function postBluesky(env: Env, p: PostInput, f: F): Promise<string> {
  const s = await f(`${PDS}/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }),
  });
  const sess: any = await s.json().catch(() => ({}));
  if (!s.ok) throw new Error(`Bluesky 登录失败：${sess.message ?? s.status}`);
  const auth = { Authorization: `Bearer ${sess.accessJwt}`, "Content-Type": "application/json" };
  const handle = sess.handle ?? env.BLUESKY_HANDLE;
  const link = (rkey: string) => `https://bsky.app/profile/${handle}/post/${rkey}`;

  // Idempotency: a recent post already links this article.
  const ls = await f(`${PDS}/com.atproto.repo.listRecords?repo=${encodeURIComponent(sess.did)}&collection=app.bsky.feed.post&limit=50`, { headers: auth });
  if (ls.ok) {
    const recs: any[] = ((await ls.json()) as any).records ?? [];
    const hit = recs.find((r) => r.value?.embed?.external?.uri === p.enUrl);
    if (hit) return link(hit.uri.split("/").pop());
  }

  const enc = new TextEncoder();
  const head = `${p.titleEn}\n\n`;
  const excerpt = cut(plain(p.bodyEn), 300 - [...head].length - [...p.enUrl].length - 3);
  const text = `${head}${excerpt}\n\n${p.enUrl}`;
  const start = enc.encode(text.slice(0, text.length - p.enUrl.length)).length;
  const record = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    langs: ["en"],
    facets: [{ index: { byteStart: start, byteEnd: start + enc.encode(p.enUrl).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: p.enUrl }] }],
    embed: { $type: "app.bsky.embed.external", external: { uri: p.enUrl, title: p.titleEn, description: cut(plain(p.bodyEn), 200) } },
  };
  const r = await f(`${PDS}/com.atproto.repo.createRecord`, { method: "POST", headers: auth, body: JSON.stringify({ repo: sess.did, collection: "app.bsky.feed.post", record }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.uri) throw new Error(`Bluesky 发帖失败：${j.message ?? r.status}`);
  return link(j.uri.split("/").pop());
}

export async function postTo(platform: string, env: Env, p: PostInput, f: F, prog?: Progress): Promise<string> {
  if (platform === "telegram") return postTelegram(env, p, f, prog, "zh");
  if (platform === "telegram_en") return postTelegram(env, p, f, prog, "en");
  if (platform === "devto") return postDevto(env, p, f);
  if (platform === "bluesky") return postBluesky(env, p, f);
  throw new Error(`未知平台 ${platform}`);
}
