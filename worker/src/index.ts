import { recordHit, collectStats, weekly, buildBackup } from "./p3";
import { Env, allowedUsers } from "./env";
import { Service } from "./service";
import { hmacHex, safeEqual, nowIso, splitTitleBody } from "./util";
import { renderPreviewHtml } from "./render";
import { deeplUsage } from "./deepl";
import { userTitle, generateTitle, heuristicTitle } from "./autotitle";
import { detectKind } from "./p4";
import { reconcile } from "./reconcile";
import { once } from "./p3";
import { sha256Bytes } from "./service";
import { enabledPlatforms } from "./platforms";
import { handleComments, deleteComment } from "./comments";

const HELP = `个人双语博客 · 写作 Bot

直接发消息投稿，每次都会先给你审核，批准后才发布。
· 短想法（约 280 字以内）：发到两个 TG 频道和 Bluesky，不进博客
· 正式文章：第一行可写标题；博客中英全文，并推荐 Medium / DEV 等
· 开头写 #想法 或 #文章 可强制类型
长文可分多条发，或 /new … /done，也可发 .md / .txt 文件。
替换封面：发图片并配文 /cover <编号>；/cover <编号> 默认 恢复自动封面
Medium 手动接管：/medium <编号> <链接> 或 /medium <编号> skip
/health 系统巡检

/list 最近文章
/status <编号> 查看状态和发布回执
/edit <编号> 修改中文（下一条消息为完整新稿）
/en <编号> 修改英文译稿（下一条消息为完整英文稿）
/retranslate <编号> 重新翻译
/retry <编号> 发布失败后从断点继续
/stats [天数] 数据统计（默认 7 天）
/quota 查看 DeepL 免费额度
/term 中文=English 添加术语
/terms 查看术语表
/cancel 取消当前操作

任何修改都会让之前的审批失效；未经你点「批准」不会发布。`;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && url.pathname === "/telegram/webhook") return await webhook(req, env, ctx);
      if (req.method === "GET" && url.pathname.startsWith("/preview/")) return await preview(url, env);
      if (url.pathname === "/hit" && (req.method === "POST" || req.method === "GET")) return await recordHit(env, url, req);
      if (url.pathname === "/comments") return await handleComments(req, url, env);
      if (url.pathname.startsWith("/admin/")) return await admin(req, url, env);
      if (url.pathname === "/") return new Response("ok", { headers: { "X-Robots-Tag": "noindex" } });
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      console.error(e);
      return new Response("error", { status: 500 });
    }
  },

  async scheduled(_ev: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await recoverUpdates(env).catch((e) => console.error("recover", e));
      await housekeeping(env);
      await new Service(env).processDueJobs();
      await weekly(env).catch((e) => console.error("weekly", e));
      if (new Date().getUTCMinutes() % 15 === 0) await monitor(env).catch((e) => console.error("monitor", e));
    })());
  },
};

// ---------------- Telegram webhook ----------------
async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
  const update: any = await req.json();

  if (typeof update?.update_id !== "number") return new Response("bad update", { status: 400 });

  const from = update.message?.from ?? update.callback_query?.from;
  const chatType = update.message?.chat?.type ?? update.callback_query?.message?.chat?.type;
  // Only allow-listed users, only in private chat. Others are ignored silently (and not stored).
  if (!from || !allowedUsers(env).has(Number(from.id)) || chatType !== "private") return new Response("ignored");

  // Telegram may redeliver; claim each update_id once. The payload is kept until processing finishes,
  // so the cron can recover an update whose worker died mid-way.
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO seen_updates (update_id, at, status, payload, attempts) VALUES (?,?,'pending',?,1)").bind(update.update_id, nowIso(), JSON.stringify(update)).run();
  if (!ins.meta.changes) return new Response("dup");

  ctx.waitUntil(runUpdate(update, env));
  return new Response("ok");
}

/** Process one update and record the outcome. Errors are reported once and never lose the original text. */
async function runUpdate(update: any, env: Env) {
  try {
    await handleUpdate(update, env);
    await env.DB.prepare("UPDATE seen_updates SET status='done', payload=NULL WHERE update_id=?").bind(update.update_id).run();
  } catch (e: any) {
    console.error(e);
    // Keep the payload as 'pending' so the cron retries text posts; tell the user once.
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (chatId) await new Service(env).tg.send(chatId, `⚠️ 处理出错：${e?.message ?? e}\n稍后会自动重试一次；你发的原文不会丢。`).catch(() => {});
  }
}

const REPLAY_AFTER_MS = 120_000;
const MAX_REPLAYS = 3;
/** Recover updates that never finished. Only new text posts are replayed (they are idempotent via source_update). */
export async function recoverUpdates(env: Env, now = Date.now()) {
  const due = await env.DB.prepare("SELECT * FROM seen_updates WHERE status='pending' AND at<=? ORDER BY update_id LIMIT 5").bind(new Date(now - REPLAY_AFTER_MS).toISOString()).all<any>();
  for (const row of due.results ?? []) {
    const update = row.payload ? JSON.parse(row.payload) : null;
    const text: string = update?.message?.text ?? "";
    const userId = update?.message?.from?.id;
    const st = userId ? await env.DB.prepare("SELECT mode FROM chat_state WHERE user_id=?").bind(userId).first<any>() : null;
    const replayable = !!update?.message && !!text && !text.startsWith("/") && !["collect_new"].includes(st?.mode ?? "idle");
    if (!replayable || row.attempts >= MAX_REPLAYS) {
      await env.DB.prepare("UPDATE seen_updates SET status='failed' WHERE update_id=?").bind(row.update_id).run();
      continue;
    }
    const claim = await env.DB.prepare("UPDATE seen_updates SET attempts=attempts+1, at=? WHERE update_id=? AND status='pending' AND attempts=?").bind(new Date(now).toISOString(), row.update_id, row.attempts).run();
    if (claim.meta.changes) await runUpdate(update, env);
  }
  // Keep the de-dup table small: payloads are already gone; drop rows older than 30 days.
  await env.DB.prepare("DELETE FROM seen_updates WHERE status!='pending' AND at<?").bind(new Date(now - 30 * 86400_000).toISOString()).run();
}

/** Alert the owner once per problem; problems clear themselves when fixed. */
export async function monitor(env: Env, now = Date.now()) {
  const owner = [...allowedUsers(env)][0];
  if (!owner) return;
  const svc = new Service(env);
  const issues = await svc.health(now);
  // Once a day, check remote copies against our records (read-only).
  const day = new Date(now).toISOString().slice(0, 10);
  await once(env, "reconcile", day, async () => {
    const r = await reconcile(env);
    await env.DB.prepare("INSERT INTO periodic_runs (name, last_key, at) VALUES ('reconcile_result', ?, ?) ON CONFLICT(name) DO UPDATE SET last_key=excluded.last_key, at=excluded.at").bind(JSON.stringify(r.problems), new Date(now).toISOString()).run();
  }).catch((e) => console.error("reconcile", e));
  // Once a day, check credentials and the free DeepL quota so a broken key is found before a publish needs it.
  await once(env, "credcheck", day, async () => {
    const found: Array<{ key: string; text: string }> = [];
    const chk = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e: any) { found.push({ key: `cred:${name}:${day}`, text: `${name} 凭据或服务检查失败：${String(e?.message ?? e).slice(0, 80)}` }); } };
    await chk("Telegram Bot", async () => { await svc.tg.call("getMe", {}); });
    await chk("DeepL", async () => { const u = await deeplUsage(env.DEEPL_API_KEY); if (u.character_limit - u.character_count < u.character_limit * 0.1) throw new Error(`免费额度剩余不足 10%（${u.character_limit - u.character_count} 字符）`); });
    if (env.DEVTO_API_KEY) await chk("dev.to", async () => { const r = await fetch("https://dev.to/api/users/me", { headers: { "api-key": env.DEVTO_API_KEY!, "User-Agent": "pbb-writer" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); });
    if (env.BLUESKY_APP_PASSWORD) await chk("Bluesky", async () => { const r = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); });
    await chk("GitHub", async () => { const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}`, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "pbb-writer" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const j: any = await r.json(); if (!j.permissions?.push) throw new Error("没有推送权限"); });
    await env.DB.prepare("INSERT INTO periodic_runs (name, last_key, at) VALUES ('credcheck_result', ?, ?) ON CONFLICT(name) DO UPDATE SET last_key=excluded.last_key, at=excluded.at").bind(JSON.stringify(found), new Date(now).toISOString()).run();
  }).catch((e) => console.error("credcheck", e));
  const cred = await env.DB.prepare("SELECT last_key FROM periodic_runs WHERE name='credcheck_result'").first<any>();
  if (cred?.last_key) for (const p of JSON.parse(cred.last_key)) issues.push(p);
  const rec = await env.DB.prepare("SELECT last_key FROM periodic_runs WHERE name='reconcile_result'").first<any>();
  if (rec?.last_key) for (const p of JSON.parse(rec.last_key)) issues.push(p);
  for (const i of issues) {
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO periodic_runs (name, last_key, at) VALUES (?,?,?)").bind(`alert:${i.key}`, "sent", new Date(now).toISOString()).run();
    if (ins.meta.changes) await svc.tg.send(owner, `🔧 ${i.text}`).catch(async () => { await env.DB.prepare("DELETE FROM periodic_runs WHERE name=?").bind(`alert:${i.key}`).run(); });
  }
  await env.DB.prepare("INSERT INTO periodic_runs (name, last_key, at) VALUES ('heartbeat', 'cron', ?) ON CONFLICT(name) DO UPDATE SET at=excluded.at").bind(new Date(now).toISOString()).run();
}

async function setState(env: Env, userId: number, mode: string, articleId: string | null = null, buffer: string | null = null) {
  await env.DB.prepare("INSERT INTO chat_state (user_id, mode, article_id, buffer, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode, article_id=excluded.article_id, buffer=excluded.buffer, updated_at=excluded.updated_at")
    .bind(userId, mode, articleId, buffer, nowIso())
    .run();
}

async function handleUpdate(update: any, env: Env) {
  const svc = new Service(env);

  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    const [kind, a, b] = String(cq.data).split(":");
    let reply = "";
    if (kind === "ap") {
      reply = await svc.approve(cq.from.id, chatId, a, b);
      if (reply === "已批准") await svc.tg.editMarkup(chatId, cq.message.message_id, { inline_keyboard: [] }).catch(() => {});
    } else if (kind === "rt") {
      reply = "重新翻译中";
      await svc.tg.answerCallback(cq.id, reply);
      return retranslate(svc, a, chatId);
    } else if (kind === "dc") {
      reply = await svc.discard(a);
    } else if (kind === "tp") {
      reply = await svc.toggleTarget(a, b, chatId, cq.message.message_id);
    } else if (kind === "st") {
      await svc.tg.send(chatId, await svc.status(a));
      reply = "ok";
    } else if (kind === "ez" || kind === "ee") {
      const art = await svc.article(a);
      if (!art) reply = "找不到这篇文章";
      else {
        await setState(env, cq.from.id, kind === "ez" ? "edit_zh" : "edit_en", a);
        const q = art.kind === "quick";
        await svc.tg.send(chatId, kind === "ez" ? `请发送完整的新中文稿${q ? "" : "（第一行标题）"}。/cancel 取消` : `请发送完整的英文稿${q ? "" : "（第一行标题）"}。/cancel 取消`);
        reply = "等待新稿";
      }
    }
    await svc.tg.answerCallback(cq.id, reply || "ok");
    return;
  }

  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = await env.DB.prepare("SELECT * FROM chat_state WHERE user_id=?").bind(userId).first<any>();
  const mode = state?.mode ?? "idle";

  // custom cover: a photo captioned "/cover <id>"
  if (msg.photo?.length) {
    const m = String(msg.caption ?? "").match(/^\/cover(?:@\w+)?\s+(\S+)/);
    if (!m) return svc.tg.send(chatId, "要替换封面，请给图片配文：/cover <编号>");
    const ph = msg.photo[msg.photo.length - 1];
    if (ph.file_size && ph.file_size > 5_000_000) return svc.tg.send(chatId, "图片太大（>5MB）");
    const bytes = await svc.downloadTgFile(ph.file_id);
    return svc.setCover(m[1], chatId, ph.file_id, await sha256Bytes(bytes));
  }
  // documents (.md / .txt)
  let text: string | null = msg.text ?? null;
  if (!text && msg.document) {
    const name: string = msg.document.file_name ?? "";
    if (!/\.(md|markdown|txt)$/i.test(name) || msg.document.file_size > 512_000) return svc.tg.send(chatId, "只支持 500KB 以内的 .md / .txt 文件");
    const f = await svc.tg.call("getFile", { file_id: msg.document.file_id });
    const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
    text = await r.text();
  }
  if (!text) return svc.tg.send(chatId, "目前只接受文字或 .md/.txt 文件");

  if (!text.startsWith("/") && !["edit_zh", "edit_en", "collect_new"].includes(mode)) {
    return postOrHold(env, svc, userId, chatId, text, state, update.update_id);
  }

  if (text.startsWith("/")) {
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.split("@")[0];
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/start":
      case "/help":
        return svc.tg.send(chatId, `${HELP}\n\n你的 Telegram ID：${userId}`);
      case "/cancel":
        await setState(env, userId, "idle");
        return svc.tg.send(chatId, "已取消");
      case "/new":
        await setState(env, userId, "collect_new", null, "");
        return svc.tg.send(chatId, "开始收稿：第一行写标题，然后分多条发送正文，发完后发 /done");
      case "/done": {
        if (mode !== "collect_new" || !state?.buffer) return svc.tg.send(chatId, "没有正在收集的稿件");
        await setState(env, userId, "idle");
        const tb = splitTitleBody(state.buffer);
        if (!tb) return svc.tg.send(chatId, "需要标题（第一行）和正文");
        await svc.createArticle(userId, chatId, tb.title, tb.body);
        return;
      }
      case "/list": {
        const r = await env.DB.prepare("SELECT a.id, a.status, v.title_zh FROM articles a LEFT JOIN versions v ON v.id=a.current_version_id ORDER BY a.created_at DESC LIMIT 10").all<any>();
        return svc.tg.send(chatId, (r.results ?? []).map((x) => `${x.id} · ${x.status}\n  ${x.title_zh}`).join("\n") || "还没有文章");
      }
      case "/status":
        return svc.tg.send(chatId, arg ? await svc.status(arg) : "用法：/status <编号>");
      case "/edit":
      case "/en": {
        if (!arg || !(await svc.article(arg))) return svc.tg.send(chatId, `用法：${cmd} <编号>`);
        await setState(env, userId, cmd === "/edit" ? "edit_zh" : "edit_en", arg);
        return svc.tg.send(chatId, cmd === "/edit" ? "请发送完整的新中文稿（第一行标题）。/cancel 取消" : "请发送完整的英文稿（第一行标题）。/cancel 取消");
      }
      case "/medium": {
        const [id, ...more] = arg.split(/\s+/);
        if (!id || !more.length) return svc.tg.send(chatId, "Medium 手动接管：发布后发 /medium <编号> <文章链接>；不发了：/medium <编号> skip");
        return svc.tg.send(chatId, await svc.mediumTakeover(id, more.join(" ")));
      }
      case "/health": {
        const issues = await svc.health();
        const hb = await env.DB.prepare("SELECT at FROM periodic_runs WHERE name='heartbeat'").first<any>();
        return svc.tg.send(chatId, `${issues.length ? issues.map((i) => `· ${i.text}`).join("\n") : "一切正常"}\n上次巡检：${hb?.at ?? "无"}`);
      }
      case "/cover": {
        const [id, opt] = arg.split(/\s+/);
        if (id && /^(默认|default|reset)$/i.test(opt ?? "")) return svc.setCover(id, chatId, null, null);
        return svc.tg.send(chatId, "替换封面：发送图片并配文 /cover <编号>；恢复自动封面：/cover <编号> 默认");
      }
      case "/retranslate":
        return arg ? retranslate(svc, arg, chatId) : svc.tg.send(chatId, "用法：/retranslate <编号>");
      case "/retry":
        return svc.tg.send(chatId, arg ? await svc.retry(arg) : "用法：/retry <编号>");
      case "/stats":
        return svc.tg.send(chatId, await collectStats(env, Number(arg) > 0 ? Math.min(Number(arg), 90) : 7));
      case "/quota":
        return svc.tg.send(chatId, await svc.quota());
      case "/term": {
        const m = arg.match(/^(.+?)\s*=\s*(.+)$/);
        if (!m) return svc.tg.send(chatId, "用法：/term 中文=English");
        await env.DB.prepare("INSERT INTO glossary (term_zh, term_en, updated_at) VALUES (?,?,?) ON CONFLICT(term_zh) DO UPDATE SET term_en=excluded.term_en, updated_at=excluded.updated_at").bind(m[1].trim(), m[2].trim(), nowIso()).run();
        return svc.tg.send(chatId, `术语已保存：${m[1].trim()} → ${m[2].trim()}（之后的翻译生效，已有译稿不自动改）`);
      }
      case "/terms": {
        const g = await svc.glossary();
        return svc.tg.send(chatId, g.map((x) => `${x.term_zh} → ${x.term_en}`).join("\n") || "术语表为空");
      }
      default:
        return svc.tg.send(chatId, "未知命令，发 /help 查看");
    }
  }

  if (mode === "collect_new") {
    const buf = state.buffer ? `${state.buffer}\n\n${text}` : text;
    if (buf.length > 200_000) return svc.tg.send(chatId, "稿件过长（>20 万字符）");
    await setState(env, userId, "collect_new", null, buf);
    return svc.tg.send(chatId, `已收到（共 ${buf.length} 字符），继续发送或 /done 完成`);
  }
  if (mode === "edit_zh" || mode === "edit_en") {
    const art = await svc.article(state.article_id);
    const tb = art?.kind === "quick" ? { title: mode === "edit_zh" ? heuristicTitle(text) : text.trim().split(/[.!?\n]/)[0].slice(0, 60), body: text.trim() } : splitTitleBody(text);
    if (!tb) return svc.tg.send(chatId, "需要标题（第一行）和正文");
    await setState(env, userId, "idle");
    return mode === "edit_zh" ? svc.editZh(state.article_id, chatId, tb.title, tb.body) : svc.editEn(state.article_id, chatId, tb.title, tb.body);
  }
  const tb = splitTitleBody(text);
  if (!tb) return svc.tg.send(chatId, "投稿格式：第一行标题，后面正文。长文请用 /new … /done");
  await svc.createArticle(userId, chatId, tb.title, tb.body);
}

// ---------------- "just send it" mode ----------------
// Telegram splits messages over 4096 chars into several updates; hold long parts briefly and join them.
const SPLIT_AT = 3900;
const HOLD_SECONDS = 25;

async function postOrHold(env: Env, svc: Service, userId: number, chatId: number, text: string, state: any, updateId: number | null) {
  const held = state?.mode === "auto_hold" ? (state.buffer ?? "") : "";
  const joined = held ? `${held}${text}` : text;
  if (text.length >= SPLIT_AT && joined.length < 200_000) {
    await setState(env, userId, "auto_hold", String(chatId), joined);
    return;
  }
  if (held) await setState(env, userId, "idle");
  await createDraft(env, svc, userId, chatId, joined, updateId);
}

/** Creates a draft for review. Nothing is published until the user approves the review card. */
async function createDraft(env: Env, svc: Service, userId: number, chatId: number, raw: string, updateId: number | null) {
  const { kind, text } = detectKind(raw);
  if (kind === "quick") return void (await svc.createArticle(userId, chatId, heuristicTitle(text), text.trim(), "quick", updateId));
  const own = userTitle(text);
  const title = own?.title ?? (await generateTitle(env.AI, text));
  const body = own?.body ?? text.trim();
  await svc.createArticle(userId, chatId, title, body, "article", updateId);
}

async function housekeeping(env: Env) {
  const svc = new Service(env);
  // Flush long messages whose follow-up part never came.
  const cutoff = new Date(Date.now() - HOLD_SECONDS * 1000).toISOString();
  const held = await env.DB.prepare("SELECT * FROM chat_state WHERE mode='auto_hold' AND updated_at<=?").bind(cutoff).all<any>();
  for (const st of held.results ?? []) {
    await setState(env, st.user_id, "idle");
    await createDraft(env, svc, st.user_id, Number(st.article_id), st.buffer ?? "", null).catch((e) => console.error(e));
  }
  // Drafts whose review card was never delivered (proofread finished, or a send failed).
  const stuck = await env.DB.prepare("SELECT a.id, a.created_by, a.current_version_id, a.review_sent_for FROM articles a JOIN versions v ON v.id=a.current_version_id WHERE a.status='in_review' AND v.translation_status='done' AND a.updated_at<=?").bind(new Date(Date.now() - 120_000).toISOString()).all<any>();
  for (const a of stuck.results ?? []) {
    if (!String(a.review_sent_for ?? "").startsWith(`${a.current_version_id}|`)) await svc.sendReview(a.current_version_id, a.created_by).catch((e) => console.error(e));
  }
}

async function retranslate(svc: Service, articleId: string, chatId: number) {
  const a = await svc.article(articleId);
  if (!a?.current_version_id) return svc.tg.send(chatId, "找不到这篇文章");
  return svc.translateAndReview(a.current_version_id, chatId);
}

// ---------------- protected preview ----------------
async function preview(url: URL, env: Env): Promise<Response> {
  const vid = url.pathname.split("/")[2] ?? "";
  const exp = Number(url.searchParams.get("exp") ?? 0);
  const sig = url.searchParams.get("sig") ?? "";
  const expect = await hmacHex(env.PREVIEW_SIGNING_KEY, `${vid}.${exp}`);
  if (!safeEqual(sig, expect) || exp < Date.now() / 1000) return new Response("链接无效或已过期", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const svc = new Service(env);
  const v = await svc.version(vid);
  if (!v || !v.en_hash) return new Response("not found", { status: 404 });
  const art = await svc.article(v.article_id);
  if (url.pathname.endsWith("/cover")) {
    if (!art?.cover_file_id) return new Response("no cover", { status: 404 });
    return new Response(await svc.downloadTgFile(art.cover_file_id), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
  }
  const st = art && art.current_version_id === v.id ? await svc.reviewState(art.id) : null;
  const html = renderPreviewHtml({
    articleId: v.article_id,
    versionNo: v.version_no,
    titleZh: v.title_zh,
    bodyZh: v.body_zh,
    titleEn: v.title_en!,
    bodyEn: v.body_en!,
    zhHash: v.zh_hash,
    enHash: v.en_hash,
    qc: v.qc_json ? JSON.parse(v.qc_json) : null,
    kind: art?.kind ?? "article",
    category: art?.category ?? "essay",
    drafts: st?.drafts ?? null,
    draftsHash: st?.draftsHash ?? null,
    coverUrl: art?.cover_file_id ? `${url.pathname}/cover${url.search}` : null,
  });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "private, no-store" } });
}

// ---------------- admin ----------------
async function admin(req: Request, url: URL, env: Env): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!env.ADMIN_TOKEN || !safeEqual(auth, `Bearer ${env.ADMIN_TOKEN}`)) return new Response("forbidden", { status: 403 });
  const svc = new Service(env);
  const json = (o: unknown) => new Response(JSON.stringify(o, null, 2), { headers: { "Content-Type": "application/json" } });

  if (url.pathname === "/admin/set-webhook" && req.method === "POST") {
    const r = await svc.tg.call("setWebhook", {
      url: `${env.WORKER_URL.replace(/\/$/, "")}/telegram/webhook`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    await svc.tg.call("setMyCommands", {
      commands: [
        ["new", "开始长文投稿"], ["done", "完成长文投稿"], ["list", "最近文章"], ["status", "查看状态"], ["edit", "修改中文"],
        ["en", "修改英文"], ["retranslate", "重新翻译"], ["retry", "失败后继续发布"], ["stats", "数据统计"], ["quota", "DeepL 额度"], ["help", "帮助"],
      ].map(([command, description]) => ({ command, description })),
    });
    return json({ setWebhook: r });
  }

  if (url.pathname === "/admin/backup-preview") return new Response(await buildBackup(env), { headers: { "Content-Type": "application/json" } });
  if (url.pathname === "/admin/reconcile") return json(await reconcile(env));
  if (url.pathname === "/admin/comment-delete" && req.method === "POST") return json({ deleted: await deleteComment(env, Number(url.searchParams.get("id"))) });
  if (url.pathname === "/admin/issues") return json({ issues: await svc.health(), heartbeat: (await env.DB.prepare("SELECT at FROM periodic_runs WHERE name='heartbeat'").first<any>())?.at ?? null });
  if (url.pathname === "/admin/health") {
    const out: Record<string, unknown> = {};
    const step = async (k: string, f: () => Promise<unknown>) => {
      try { out[k] = { ok: true, ...((await f()) as object) }; } catch (e: any) { out[k] = { ok: false, error: String(e?.message ?? e) }; }
    };
    await step("d1", async () => ({ articles: (await env.DB.prepare("SELECT COUNT(*) n FROM articles").first<any>())?.n }));
    await step("telegram", async () => { const me = await svc.tg.call("getMe", {}); const wh = await svc.tg.call("getWebhookInfo", {}); return { bot: me.username, webhook: wh.url, pending: wh.pending_update_count, last_error: wh.last_error_message ?? null }; });
    await step("deepl", async () => { const u = await deeplUsage(env.DEEPL_API_KEY); return { used: u.character_count, limit: u.character_limit, keyType: "free(:fx)" }; });
    if (env.DEVTO_API_KEY) await step("devto", async () => { const r = await fetch("https://dev.to/api/users/me", { headers: { "api-key": env.DEVTO_API_KEY!, "User-Agent": "pbb-writer" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const j: any = await r.json(); return { user: j.username }; });
    if (env.TELEGRAM_CHANNEL) await step("telegram_channel", async () => { const c = await svc.tg.call("getChat", { chat_id: env.TELEGRAM_CHANNEL }); return { title: c.title, username: c.username }; });
    if (env.BLUESKY_APP_PASSWORD) await step("bluesky", async () => { const r = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD }) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const j: any = await r.json(); return { handle: j.handle }; });
    if (env.TELEGRAM_CHANNEL_EN) await step("telegram_channel_en", async () => { const c = await svc.tg.call("getChat", { chat_id: env.TELEGRAM_CHANNEL_EN }); return { title: c.title, username: c.username }; });
    out.platforms = enabledPlatforms(env);
    await step("github", async () => {
      const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}`, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": "pbb", Accept: "application/vnd.github+json" } });
      const j: any = await r.json(); if (!r.ok) throw new Error(`HTTP ${r.status}`); return { repo: j.full_name, private: j.private, push: j.permissions?.push ?? null };
    });
    await step("pages", async () => {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${env.PAGES_PROJECT}`, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
      const j: any = await r.json(); if (!r.ok) throw new Error(`HTTP ${r.status}`); return { project: j.result?.name, subdomain: j.result?.subdomain, production_branch: j.result?.production_branch };
    });
    out.config = { mode: env.PUBLISH_MODE, branch: env.GITHUB_BRANCH, allowedUsers: [...allowedUsers(env)].length, site: env.SITE_URL };
    return json(out);
  }

  if (url.pathname === "/admin/clear-commands" && req.method === "POST") {
    const tg = new Service(env).tg;
    await tg.call("deleteMyCommands", {});
    await tg.call("setChatMenuButton", { menu_button: { type: "default" } });
    return Response.json({ ok: true, commands: await tg.call("getMyCommands", {}) });
  }
  if (url.pathname === "/admin/title-test" && req.method === "POST") {
    const t = await req.text();
    return Response.json({ own: userTitle(t), generated: await generateTitle(env.AI, t) });
  }
  if (url.pathname === "/admin/channel-delete" && req.method === "POST") {
    const { message_id } = (await req.json()) as any;
    const svc = new Service(env);
    return Response.json(await svc.tg.call("deleteMessage", { chat_id: env.TELEGRAM_CHANNEL, message_id }));
  }
  if (url.pathname === "/admin/jobs") {
    const r = await env.DB.prepare("SELECT id, article_id, platform, stage, status, attempts, commit_sha, deployment_url, public_urls, last_error, updated_at FROM publish_jobs ORDER BY created_at DESC LIMIT 20").all();
    const ev = await env.DB.prepare("SELECT * FROM publish_events ORDER BY id DESC LIMIT 40").all();
    return json({ jobs: r.results, events: ev.results });
  }

  if (url.pathname === "/admin/run-jobs" && req.method === "POST") {
    await svc.processDueJobs(10);
    return json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}
