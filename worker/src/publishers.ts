/**
 * P4 publishers: post exactly the approved draft for one platform, idempotently.
 * Every publisher first checks the remote side for work a timed-out attempt may already have done.
 */
import type { Env } from "./env";
import { tid } from "./p4";
import { nowIso } from "./util";

type F = typeof fetch;
export class AuthError extends Error {}
export class ExternalWait extends Error {}

export interface JobCtx {
  jobId: string;
  createdAt: string; // job creation time, seeds deterministic remote ids
  state: any; // persisted progress (JSON)
  save(state: any): Promise<void>;
  previous?: { remote: any; urls: string[]; contentHash: string | null } | null; // last done job for this article+platform
  contentHash: string;
}
export interface Result { url: string; remote: any; note?: string }

const TIMEOUT_MS = 20_000;
const withTimeout = (init: RequestInit = {}): RequestInit => ({ ...init, signal: (AbortSignal as any).timeout ? (AbortSignal as any).timeout(TIMEOUT_MS) : undefined });

// ---------------- Telegram channels ----------------
function chanOf(env: Env, p: string): string {
  const tc = (p === "telegram" ? env.TELEGRAM_CHANNEL : env.TELEGRAM_CHANNEL_EN) ?? "";
  return tc.startsWith("@") || tc.startsWith("-") ? tc : `@${tc}`;
}
async function tgCall(env: Env, f: F, method: string, payload: any): Promise<any> {
  const r = await f(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, withTimeout({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) throw new AuthError(`Telegram 凭据或频道权限失效：${j.description ?? r.status}`);
  return j;
}
async function cursor(env: Env, chat: string): Promise<number> {
  const r = await env.DB.prepare("SELECT last_message_id n FROM channel_cursor WHERE chat=?").bind(chat).first<any>();
  return r?.n ?? 0;
}
async function bump(env: Env, chat: string, id: number) {
  await env.DB.prepare("INSERT INTO channel_cursor (chat, last_message_id, at) VALUES (?,?,?) ON CONFLICT(chat) DO UPDATE SET last_message_id=MAX(last_message_id, excluded.last_message_id), at=excluded.at").bind(chat, id, nowIso()).run();
}
/**
 * Did a timed-out send actually land? Non-destructive check: clearing the (absent) keyboard of one of
 * our own messages answers "not modified"; other people's posts answer "can't be edited"; gaps answer "not found".
 */
async function probe(env: Env, f: F, chat: string, after: number): Promise<number | null> {
  for (let id = after + 1; id <= after + 4; id++) {
    const j = await tgCall(env, f, "editMessageReplyMarkup", { chat_id: chat, message_id: id, reply_markup: { inline_keyboard: [] } });
    if (j.ok || /not modified/i.test(j.description ?? "")) return id;
  }
  return null;
}
const tgUrl = (chat: string, id: number) => (chat.startsWith("@") ? `https://t.me/${chat.slice(1)}/${id}` : `https://t.me/c/${chat.replace(/^-100/, "")}/${id}`);

export async function publishTelegram(env: Env, platform: string, draft: { messages: string[] }, ctx: JobCtx, f: F): Promise<Result> {
  const chat = chanOf(env, platform);
  const msgs = draft.messages;
  const st: { ids: number[]; pending?: { i: number; after: number } } = ctx.state ?? { ids: [] };
  const prevIds: number[] = ctx.previous?.remote?.ids ?? [];

  // Update of an already published post: edit in place, add/remove the difference.
  if (prevIds.length && !st.ids.length) {
    if (ctx.previous?.contentHash === ctx.contentHash) return { url: ctx.previous.urls[0], remote: ctx.previous.remote, note: "内容未变，无需同步" };
    const ids: number[] = [];
    for (let i = 0; i < msgs.length; i++) {
      if (i < prevIds.length) {
        const j = await tgCall(env, f, "editMessageText", { chat_id: chat, message_id: prevIds[i], text: msgs[i], parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        if (!j.ok && !/not modified/i.test(j.description ?? "")) throw new Error(`Telegram 编辑失败：${j.description}`);
        ids.push(prevIds[i]);
      } else {
        const j = await tgCall(env, f, "sendMessage", { chat_id: chat, text: msgs[i], parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        if (!j.ok) throw new Error(`Telegram 发送失败：${j.description}`);
        ids.push(j.result.message_id);
        await bump(env, chat, j.result.message_id);
      }
    }
    for (const extra of prevIds.slice(msgs.length)) await tgCall(env, f, "deleteMessage", { chat_id: chat, message_id: extra });
    await ctx.save({ ids });
    return { url: tgUrl(chat, ids[0]), remote: { chat, ids }, note: "已编辑原消息" };
  }

  for (let i = st.ids.length; i < msgs.length; i++) {
    if (st.pending?.i === i) {
      if (!st.pending.after) throw new AuthError("上次发送超时且无法核查频道（无消息游标），为避免重复已停止；请检查频道后用 /retry 继续");
      const found = await probe(env, f, chat, st.pending.after);
      if (found) { st.ids.push(found); delete st.pending; await bump(env, chat, found); await ctx.save(st); continue; }
    }
    st.pending = { i, after: await cursor(env, chat) };
    await ctx.save(st);
    const j = await tgCall(env, f, "sendMessage", { chat_id: chat, text: msgs[i], parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    if (!j.ok) throw new Error(`Telegram 频道发送失败：${j.description ?? "unknown"}`);
    st.ids.push(j.result.message_id);
    delete st.pending;
    await bump(env, chat, j.result.message_id);
    await ctx.save(st);
  }
  return { url: tgUrl(chat, st.ids[0]), remote: { chat, ids: st.ids } };
}

// ---------------- Bluesky ----------------
const PDS = "https://bsky.social/xrpc";
const enc = new TextEncoder();

function facets(text: string) {
  const out: any[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)]+/g)) {
    const start = enc.encode(text.slice(0, m.index)).length;
    out.push({ index: { byteStart: start, byteEnd: start + enc.encode(m[0]).length }, features: [{ $type: "app.bsky.richtext.facet#link", uri: m[0] }] });
  }
  return out;
}

export async function publishBluesky(env: Env, draft: { posts: string[]; embedUrl?: string }, ctx: JobCtx, f: F, siteUrl: string): Promise<Result> {
  const s = await f(`${PDS}/com.atproto.server.createSession`, withTimeout({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }) }));
  const sess: any = await s.json().catch(() => ({}));
  if (s.status === 401 || sess.error === "AuthenticationRequired") throw new AuthError(`Bluesky 应用密码失效：${sess.message ?? s.status}`);
  if (!s.ok) throw new Error(`Bluesky 登录失败：${sess.message ?? s.status}`);
  const auth = { Authorization: `Bearer ${sess.accessJwt}`, "Content-Type": "application/json" };
  const handle = sess.handle ?? env.BLUESKY_HANDLE;
  const link = (rkey: string) => `https://bsky.app/profile/${handle}/post/${rkey}`;

  if (ctx.previous?.urls?.length) {
    // Bluesky posts cannot be edited; never repost an update.
    return { url: ctx.previous.urls[0], remote: ctx.previous.remote, note: ctx.previous.contentHash === ctx.contentHash ? "内容未变" : "Bluesky 不支持编辑，保留原帖未同步" };
  }

  const ms = new Date(ctx.createdAt).getTime();
  const clock = parseInt(ctx.jobId.slice(-3), 16) || 0;
  const done: Array<{ uri: string; cid: string; rkey: string }> = ctx.state?.done ?? [];
  for (let i = done.length; i < draft.posts.length; i++) {
    const rkey = tid(ms, clock, i);
    // Timed-out create? Look before posting again.
    const g = await f(`${PDS}/com.atproto.repo.getRecord?repo=${encodeURIComponent(sess.did)}&collection=app.bsky.feed.post&rkey=${rkey}`, withTimeout({ headers: auth }));
    if (g.ok) {
      const gj: any = await g.json();
      done.push({ uri: gj.uri, cid: gj.cid, rkey });
      await ctx.save({ done });
      continue;
    }
    const text = draft.posts[i];
    const record: any = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), langs: ["en"] };
    const fc = facets(text);
    if (fc.length) record.facets = fc;
    if (i > 0) record.reply = { root: { uri: done[0].uri, cid: done[0].cid }, parent: { uri: done[i - 1].uri, cid: done[i - 1].cid } };
    if (i === draft.posts.length - 1 && draft.embedUrl) {
      const external: any = { uri: draft.embedUrl, title: draft.posts[0].split("\n")[0], description: "" };
      const og = ogUrlFor(siteUrl, draft.embedUrl);
      if (og) {
        try {
          const img = await f(og, withTimeout());
          if (img.ok && (img.headers.get("content-type") ?? "").startsWith("image/")) {
            const buf = await img.arrayBuffer();
            if (buf.byteLength < 950_000) {
              const up = await f(`${PDS}/com.atproto.repo.uploadBlob`, withTimeout({ method: "POST", headers: { Authorization: auth.Authorization, "Content-Type": img.headers.get("content-type")! }, body: buf }));
              if (up.ok) external.thumb = ((await up.json()) as any).blob;
            }
          }
        } catch { /* cover is optional */ }
      }
      record.embed = { $type: "app.bsky.embed.external", external };
    }
    const r = await f(`${PDS}/com.atproto.repo.createRecord`, withTimeout({ method: "POST", headers: auth, body: JSON.stringify({ repo: sess.did, collection: "app.bsky.feed.post", rkey, record }) }));
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.uri) throw new Error(`Bluesky 发帖失败（第 ${i + 1} 条）：${j.message ?? r.status}`);
    done.push({ uri: j.uri, cid: j.cid, rkey });
    await ctx.save({ done });
  }
  return { url: link(done[0].rkey), remote: { did: sess.did, rkeys: done.map((d) => d.rkey) } };
}

export function ogUrlFor(siteUrl: string, postUrl: string): string | null {
  const m = postUrl.match(/\/(zh|en)\/posts\/([^/]+)\/?$/);
  return m ? `${siteUrl.replace(/\/$/, "")}/og/${m[1]}/${m[2]}.png` : null;
}

// ---------------- dev.to ----------------
export async function publishDevto(env: Env, draft: { title: string; body: string; canonical: string; tags: string[] }, ctx: JobCtx, f: F): Promise<Result> {
  const h: Record<string, string> = { "api-key": env.DEVTO_API_KEY ?? "", "Content-Type": "application/json", Accept: "application/vnd.forem.api-v1+json", "User-Agent": "pbb-writer" };
  // Remote check first: an article with this canonical URL means an earlier (maybe timed-out) attempt landed.
  const mine = await f("https://dev.to/api/articles/me/all?per_page=100", withTimeout({ headers: h }));
  if (mine.status === 401) throw new AuthError("dev.to API 密钥无效");
  if (!mine.ok) throw new Error(`dev.to 查询失败：HTTP ${mine.status}`);
  const list: any[] = await mine.json();
  const hit = list.find((a) => a.canonical_url === draft.canonical);
  if (hit?.url) {
    if (hit.body_markdown !== undefined && (hit.body_markdown !== draft.body || hit.title !== draft.title)) {
      const u = await f(`https://dev.to/api/articles/${hit.id}`, withTimeout({ method: "PUT", headers: h, body: JSON.stringify({ article: { title: draft.title, body_markdown: draft.body, tags: draft.tags } }) }));
      if (u.status === 401) throw new AuthError("dev.to API 密钥无效");
      if (!u.ok) throw new Error(`dev.to 更新失败：HTTP ${u.status}`);
      return { url: hit.url, remote: { id: hit.id }, note: "已更新原文" };
    }
    return { url: hit.url, remote: { id: hit.id }, note: "已存在" };
  }
  const r = await f("https://dev.to/api/articles", withTimeout({ method: "POST", headers: h, body: JSON.stringify({ article: { title: draft.title, body_markdown: draft.body, published: true, canonical_url: draft.canonical, tags: draft.tags } }) }));
  if (r.status === 401) throw new AuthError("dev.to API 密钥无效");
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.url) throw new Error(`dev.to 发布失败：HTTP ${r.status} ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  return { url: j.url, remote: { id: j.id } };
}
