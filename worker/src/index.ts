import { Env, allowedUsers } from "./env";
import { Service } from "./service";
import { hmacHex, safeEqual, nowIso, splitTitleBody } from "./util";
import { renderPreviewHtml } from "./render";
import { deeplUsage } from "./deepl";
import { userTitle, generateTitle } from "./autotitle";

const HELP = `个人双语博客 · 写作 Bot

直接发一条消息即可投稿：第一行是标题，后面是正文（支持 Markdown）。
长文：先发 /new，再分多条发送，最后发 /done。
也可以直接发送 .md / .txt 文件。

/list 最近文章
/status <编号> 查看状态和发布回执
/edit <编号> 修改中文（下一条消息为完整新稿）
/en <编号> 修改英文译稿（下一条消息为完整英文稿）
/retranslate <编号> 重新翻译
/retry <编号> 发布失败后从断点继续
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
      if (env.AUTO_PUBLISH === "true") await autoHousekeeping(env);
      await new Service(env).processDueJobs();
    })());
  },
};

// ---------------- Telegram webhook ----------------
async function webhook(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
  const update: any = await req.json();

  // Telegram may redeliver; process each update_id once.
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO seen_updates (update_id, at) VALUES (?,?)").bind(update.update_id, nowIso()).run();
  if (!ins.meta.changes) return new Response("dup");

  const from = update.message?.from ?? update.callback_query?.from;
  const chatType = update.message?.chat?.type ?? update.callback_query?.message?.chat?.type;
  // Only allow-listed users, only in private chat. Others are ignored silently.
  if (!from || !allowedUsers(env).has(Number(from.id)) || chatType !== "private") return new Response("ignored");

  ctx.waitUntil(
    handleUpdate(update, env).catch(async (e) => {
      console.error(e);
      const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
      if (chatId) await new Service(env).tg.send(chatId, `⚠️ 处理出错：${e?.message ?? e}`).catch(() => {});
    }),
  );
  return new Response("ok");
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

  if (env.AUTO_PUBLISH === "true" && !text.startsWith("/") && !["edit_zh", "edit_en", "collect_new"].includes(mode)) {
    return autoPost(env, svc, userId, chatId, text, state);
  }
  if (env.AUTO_PUBLISH === "true" && (text.trim() === "/start" || text.trim() === "/help")) {
    return svc.tg.send(chatId, "直接发文字就行，我会翻译成中英双语并发布。\n第一行想写标题就写（短短一行），不写我来起。\n发布后告诉你发到了哪里。");
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
      case "/retranslate":
        return arg ? retranslate(svc, arg, chatId) : svc.tg.send(chatId, "用法：/retranslate <编号>");
      case "/retry":
        return svc.tg.send(chatId, arg ? await svc.retry(arg) : "用法：/retry <编号>");
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
    const tb = splitTitleBody(text);
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

async function autoPost(env: Env, svc: Service, userId: number, chatId: number, text: string, state: any) {
  const held = state?.mode === "auto_hold" ? (state.buffer ?? "") : "";
  const joined = held ? `${held}${text}` : text;
  if (text.length >= SPLIT_AT && joined.length < 200_000) {
    await setState(env, userId, "auto_hold", String(chatId), joined);
    return;
  }
  if (held) await setState(env, userId, "idle");
  await publishText(env, svc, userId, chatId, joined);
}

async function publishText(env: Env, svc: Service, userId: number, chatId: number, text: string) {
  const own = userTitle(text);
  const title = own?.title ?? (await generateTitle(env.AI, text));
  const body = own?.body ?? text.trim();
  await svc.createArticle(userId, chatId, title, body);
}

async function autoHousekeeping(env: Env) {
  const svc = new Service(env);
  // Flush long messages whose follow-up part never came.
  const cutoff = new Date(Date.now() - HOLD_SECONDS * 1000).toISOString();
  const held = await env.DB.prepare("SELECT * FROM chat_state WHERE mode='auto_hold' AND updated_at<=?").bind(cutoff).all<any>();
  for (const st of held.results ?? []) {
    await setState(env, st.user_id, "idle");
    await publishText(env, svc, st.user_id, Number(st.article_id), st.buffer ?? "").catch((e) => console.error(e));
  }
  // Drafts that finished translating but whose auto-approval was cut off.
  const stuck = await env.DB.prepare("SELECT a.id, a.created_by, a.current_version_id FROM articles a JOIN versions v ON v.id=a.current_version_id WHERE a.status='in_review' AND v.translation_status='done' AND a.updated_at<=?").bind(new Date(Date.now() - 120_000).toISOString()).all<any>();
  for (const a of stuck.results ?? []) {
    await svc.autoApprove(a.current_version_id, a.created_by).catch((e) => console.error(e));
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
        ["en", "修改英文"], ["retranslate", "重新翻译"], ["retry", "失败后继续发布"], ["quota", "DeepL 额度"], ["help", "帮助"],
      ].map(([command, description]) => ({ command, description })),
    });
    return json({ setWebhook: r });
  }

  if (url.pathname === "/admin/health") {
    const out: Record<string, unknown> = {};
    const step = async (k: string, f: () => Promise<unknown>) => {
      try { out[k] = { ok: true, ...((await f()) as object) }; } catch (e: any) { out[k] = { ok: false, error: String(e?.message ?? e) }; }
    };
    await step("d1", async () => ({ articles: (await env.DB.prepare("SELECT COUNT(*) n FROM articles").first<any>())?.n }));
    await step("telegram", async () => { const me = await svc.tg.call("getMe", {}); const wh = await svc.tg.call("getWebhookInfo", {}); return { bot: me.username, webhook: wh.url, pending: wh.pending_update_count, last_error: wh.last_error_message ?? null }; });
    await step("deepl", async () => { const u = await deeplUsage(env.DEEPL_API_KEY); return { used: u.character_count, limit: u.character_limit, keyType: "free(:fx)" }; });
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
