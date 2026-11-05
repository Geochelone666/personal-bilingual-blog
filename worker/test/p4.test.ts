import { describe, it, expect } from "vitest";
import { makeWorld } from "./world";
import { detectKind, classify, recommend, pack, bskyThread, tgMessages, graphemes, tid } from "../src/p4";

const ARTICLE_FIN =
  "#文章\nAI 革命或许能挺过去，科技股呢？\n除了编程，我也投资股票。最近大事很多：中期选举、美联储加息，以及 Anthropic 即将上市。\n\n" +
  "我认为 AI 本身不会消失，但科技股的估值已经很高，纳斯达克和芯片股都在回调。投资需要谨慎，仓位要控制。\n\n" +
  "美联储仍倾向继续加息，利率高企时，高估值的科技股最先受伤。".repeat(2);
const ARTICLE_DEV = "#文章\n用 Astro 做双语博客\n我用 `npm create astro` 建站，然后写了 TypeScript 代码把 Markdown 部署到 Cloudflare Pages。\n\n```ts\nconsole.log(1)\n```\n\n部署很简单，开源框架真好用。";
const QUICK = "今天想到：写作最难的不是开头，而是每天都写。坚持比灵感重要。";

/** Fake Bluesky / dev.to / channel side on top of the base world. */
function platformWorld() {
  const w = makeWorld();
  Object.assign(w.env, {
    ENABLED_PLATFORMS: "blog,telegram,telegram_en,bluesky,medium,devto",
    TELEGRAM_CHANNEL: "@zh",
    TELEGRAM_CHANNEL_EN: "@en",
    DEVTO_API_KEY: "k",
    BLUESKY_HANDLE: "me.bsky.social",
    BLUESKY_APP_PASSWORD: "pw",
  });
  const base = (globalThis as any).fetch;
  const state = {
    bsky: new Map<string, any>(), // rkey -> record
    bskyCreates: 0,
    bskyTimeoutOnce: false,
    bskyAuthFail: false,
    devto: [] as any[],
    devtoPosts: 0,
    devtoPuts: 0,
    devtoFail: 0 as number, // number of 422s to return
    devtoAuthFail: false,
    chan: new Map<string, Map<number, string>>(), // chat -> id -> text
    chanSends: 0,
    chanEdits: 0,
    chanTimeoutOnce: false,
  };
  let nextMsg = 100;
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  (globalThis as any).fetch = async (input: any, init: any = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    if (url.host === "bsky.social") {
      const p = url.pathname.replace("/xrpc/", "");
      if (p === "com.atproto.server.createSession") return state.bskyAuthFail ? json({ error: "AuthenticationRequired", message: "Invalid identifier or password" }, 401) : json({ accessJwt: "jwt", did: "did:plc:me", handle: "me.bsky.social" });
      if (p === "com.atproto.repo.getRecord") {
        const r = state.bsky.get(url.searchParams.get("rkey")!);
        return r ? json({ uri: `at://did:plc:me/app.bsky.feed.post/${url.searchParams.get("rkey")}`, cid: "cid", value: r }) : json({ error: "RecordNotFound" }, 400);
      }
      if (p === "com.atproto.repo.uploadBlob") return json({ blob: { ref: "b" } });
      if (p === "com.atproto.repo.createRecord") {
        const b = JSON.parse(init.body);
        if (state.bsky.has(b.rkey)) return json({ error: "InvalidRequest", message: "record exists" }, 400);
        state.bskyCreates++;
        state.bsky.set(b.rkey, b.record);
        if (state.bskyTimeoutOnce) { state.bskyTimeoutOnce = false; const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }
        return json({ uri: `at://did:plc:me/app.bsky.feed.post/${b.rkey}`, cid: "cid" });
      }
    }
    if (url.host === "blog.example" && url.pathname.startsWith("/og/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    if (url.host === "dev.to") {
      if (state.devtoAuthFail) return json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/articles/me/all") return json(state.devto);
      if (url.pathname === "/api/articles" && method === "POST") {
        state.devtoPosts++;
        if (state.devtoFail > 0) { state.devtoFail--; return json({ error: "boom" }, 422); }
        const a = JSON.parse(init.body).article;
        const row = { id: state.devto.length + 1, url: `https://dev.to/me/a${state.devto.length + 1}`, canonical_url: a.canonical_url, body_markdown: a.body_markdown, title: a.title };
        state.devto.push(row);
        return json(row, 201);
      }
      if (method === "PUT") {
        state.devtoPuts++;
        const id = Number(url.pathname.split("/").pop());
        const a = JSON.parse(init.body).article;
        Object.assign(state.devto.find((x) => x.id === id), { body_markdown: a.body_markdown, title: a.title });
        return json({ id });
      }
    }
    if (url.host === "api.telegram.org") {
      const m = url.pathname.split("/").pop()!;
      const b = init.body ? JSON.parse(init.body) : {};
      if (typeof b.chat_id === "string" && b.chat_id.startsWith("@")) {
        const ch = state.chan.get(b.chat_id) ?? new Map();
        state.chan.set(b.chat_id, ch);
        if (m === "sendMessage") {
          state.chanSends++;
          const id = nextMsg++;
          ch.set(id, b.text);
          if (state.chanTimeoutOnce) { state.chanTimeoutOnce = false; const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }
          return json({ ok: true, result: { message_id: id, chat: { id: -100, username: b.chat_id.slice(1) } } });
        }
        if (m === "editMessageReplyMarkup") return ch.has(b.message_id) ? json({ ok: false, description: "Bad Request: message is not modified" }, 400) : json({ ok: false, description: "Bad Request: message to edit not found" }, 400);
        if (m === "editMessageText") {
          if (!ch.has(b.message_id)) return json({ ok: false, description: "message to edit not found" }, 400);
          state.chanEdits++;
          ch.set(b.message_id, b.text);
          return json({ ok: true, result: { message_id: b.message_id } });
        }
        if (m === "deleteMessage") { ch.delete(b.message_id); return json({ ok: true, result: true }); }
      }
    }
    return base(input, init);
  };
  const run = async (n = 12) => {
    for (let i = 0; i < n; i++) await w.tick();
  };
  const ap = () => w.lastButtons().find((b) => b.startsWith("ap:"))!;
  const art = async () => (await w.DB.prepare("SELECT * FROM articles ORDER BY created_at DESC").first()) as any;
  const jobs = async () => (await w.DB.prepare("SELECT * FROM publish_jobs ORDER BY created_at, platform").all<any>()).results as any[];
  return { w, state, run, ap, art, jobs, restore: () => ((globalThis as any).fetch = base) };
}

describe("P4 rules", () => {
  it("detects quick thoughts vs articles, explicit tags win", () => {
    expect(detectKind(QUICK).kind).toBe("quick");
    expect(detectKind(ARTICLE_FIN).kind).toBe("article");
    expect(detectKind("#想法\n" + "长".repeat(600)).kind).toBe("quick");
    expect(detectKind("#文章\n短").kind).toBe("article");
  });
  it("classifies deterministically and keeps markets/politics off DEV", () => {
    const fin = classify("AI 革命或许能挺过去，科技股呢？", ARTICLE_FIN);
    expect(fin.category).toBe("finance");
    const recs = recommend("article", fin.category, ["blog", "telegram", "telegram_en", "bluesky", "medium", "devto"], fin.scores.dev, fin.hasCode);
    expect(recs.find((r) => r.platform === "devto")!.recommended).toBe(false);
    expect(recs.find((r) => r.platform === "medium")!.recommended).toBe(true);
    const dev = classify("用 Astro 做双语博客", ARTICLE_DEV);
    expect(dev.category).toBe("dev");
    expect(recommend("article", "dev", ["blog", "devto"], dev.scores.dev, dev.hasCode).find((r) => r.platform === "devto")!.recommended).toBe(true);
    expect(classify("政治", "中期选举 国会 总统 政策 关税").category).toBe("politics");
  });
  it("Bluesky: whole sentences only, ≤300 graphemes, no mid-sentence 'read more'", () => {
    const long = "Writing every day matters more than talent. ".repeat(20).trim();
    const parts = pack(long, 294);
    expect(parts.every((p) => graphemes(p) <= 294)).toBe(true);
    expect(parts.every((p) => /\.$/.test(p))).toBe(true);
    const t = bskyThread({ kind: "quick", category: "essay", titleZh: "", bodyZh: "", titleEn: "", bodyEn: long });
    expect(t.length).toBeGreaterThan(1);
    expect(t.every((p) => graphemes(p) <= 300)).toBe(true);
    const a = bskyThread({ kind: "article", category: "finance", titleZh: "", bodyZh: "", titleEn: "Title", bodyEn: long, enUrl: "https://b/en/posts/x/" });
    expect(a[0].startsWith("Title\n\n")).toBe(true);
    expect(a.at(-1)).toContain("https://b/en/posts/x/");
    expect(a.slice(0, -1).every((p) => !p.includes("…") && /\.$/.test(p))).toBe(true);
  });
  it("Telegram: long articles become summary + link, short ones full text", () => {
    const d = { kind: "article" as const, category: "essay" as const, titleZh: "标", bodyZh: "很长的句子。".repeat(1000), titleEn: "T", bodyEn: "Long sentence. ".repeat(600), zhUrl: "https://b/zh/posts/x/", enUrl: "https://b/en/posts/x/" };
    const zh = tgMessages(d, "zh");
    expect(zh.length).toBe(1);
    expect(zh[0].length).toBeLessThan(1200);
    expect(zh[0]).toContain("阅读全文");
    const short = tgMessages({ ...d, bodyZh: "短文。" }, "zh");
    expect(short[0]).toContain("短文。");
  });
  it("tids are valid 13-char sortable keys and deterministic", () => {
    const a = tid(Date.UTC(2026, 10, 5), 7, 0);
    expect(a).toMatch(/^[234567a-z]{13}$/);
    expect(tid(Date.UTC(2026, 10, 5), 7, 0)).toBe(a);
    expect(tid(Date.UTC(2026, 10, 5), 7, 1) > a).toBe(true);
  });
});

describe("P4 end-to-end (fake platforms)", () => {
  it("1+4 quick thought: bilingual draft, full Bluesky/TG drafts in review, no blog; single-platform publish", async () => {
    const t = platformWorld();
    await t.w.text(QUICK);
    const a = await t.art();
    expect(a.kind).toBe("quick");
    const msgs = t.w.texts();
    expect(msgs.some((m) => m.includes("【中文原稿】") && m.includes("【英文译稿】") && m.includes("【Bluesky"))).toBe(true);
    const buttons = t.w.lastButtons();
    expect(buttons.some((b) => b === `tp:${a.id}:blog`)).toBe(false);
    // keep only Bluesky
    await t.w.click(`tp:${a.id}:telegram`);
    await t.w.click(`tp:${a.id}:telegram_en`);
    const card = [...t.w.sent].reverse().find((s) => s.method === "editMessageText")!;
    const ap = card.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data).find((d: string) => d.startsWith("ap:"));
    await t.w.click(ap);
    await t.run(3);
    const jobs = await t.jobs();
    expect(jobs.map((j) => j.platform)).toEqual(["bluesky"]);
    expect(jobs[0].status).toBe("done");
    expect((await t.art()).status).toBe("published");
    expect(t.state.chanSends).toBe(0);
    expect(t.w.texts().some((m) => m.includes("已发布") && m.includes("bsky.app"))).toBe(true);
    t.restore();
  });

  it("3 changing targets or the cover invalidates the shown approve button", async () => {
    const t = platformWorld();
    await t.w.text(ARTICLE_FIN);
    const a = await t.art();
    const old = t.ap();
    await t.w.click(`tp:${a.id}:medium`);
    await t.w.click(old);
    expect(t.w.sent.filter((s) => s.method === "answerCallbackQuery").at(-1)!.payload.text).toMatch(/不一致|失效/);
    expect((await t.w.DB.prepare("SELECT COUNT(*) n FROM approvals").first<any>()).n).toBe(0);
    // cover change
    const card = [...t.w.sent].reverse().find((s) => s.method === "editMessageText")!;
    const ap2 = card.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data).find((d: string) => d.startsWith("ap:"));
    await t.w.text(`/cover ${a.id} 默认`); // reset (no-op content-wise but still re-review)
    await t.w.DB.prepare("UPDATE articles SET cover_sha='abc', cover_file_id='f' WHERE id=?").bind(a.id).run();
    await t.w.click(ap2);
    expect((await t.w.DB.prepare("SELECT COUNT(*) n FROM approvals").first<any>()).n).toBe(0);
    t.restore();
  });

  it("4+5+7 multi-platform article: blog first, concurrent double click, timeouts checked remotely, no duplicates", async () => {
    const t = platformWorld();
    await t.w.text(ARTICLE_FIN);
    const ap = t.ap();
    t.state.bskyTimeoutOnce = true;
    t.state.chanTimeoutOnce = true;
    for (const c of ["@zh", "@en"]) await t.w.DB.prepare("INSERT INTO channel_cursor (chat, last_message_id, at) VALUES (?, 99, 'x')").bind(c).run();
    await Promise.all([t.w.click(ap), t.w.click(ap)]);
    expect((await t.w.DB.prepare("SELECT COUNT(*) n FROM approvals").first<any>()).n).toBe(1);
    const jobs0 = await t.jobs();
    expect(jobs0.map((j) => j.platform).sort()).toEqual(["blog", "bluesky", "medium", "telegram", "telegram_en"]);
    await t.w.tick(); // blog committing; cross-posts must wait
    expect(t.state.chanSends + t.state.bskyCreates).toBe(0);
    await t.run(15);
    const jobs = await t.jobs();
    const by = Object.fromEntries(jobs.map((j) => [j.platform, j]));
    expect(by.blog.status).toBe("done");
    expect(by.telegram.status).toBe("done");
    expect(by.telegram_en.status).toBe("done");
    expect(by.bluesky.status).toBe("done");
    expect(by.medium.stage).toBe("external");
    // TG: the timed-out send was found by probing, not repeated
    expect(t.state.chanSends).toBe(2);
    // Bluesky: thread posts each created exactly once despite the timeout
    const posts = JSON.parse(by.bluesky.remote_id).rkeys.length;
    expect(t.state.bskyCreates).toBe(posts);
    const ev = (await t.w.DB.prepare("SELECT stage FROM publish_events WHERE stage='retry'").all<any>()).results;
    expect(ev.length).toBeGreaterThanOrEqual(2);
    const rec = t.w.texts().filter((m) => m.includes("》已发布") || m.includes("部分发布"));
    expect(rec.length).toBe(1);
    expect(rec[0]).toContain("Medium：排队中");
    t.restore();
  });

  it("6+9 partial failure and invalid credentials: dev.to 401 fails fast, other platforms still publish", async () => {
    const t = platformWorld();
    t.state.devtoAuthFail = true;
    await t.w.text(ARTICLE_DEV);
    expect((await t.art()).category).toBe("dev");
    await t.w.click(t.ap());
    await t.run(12);
    const by = Object.fromEntries((await t.jobs()).map((j) => [j.platform, j]));
    expect(by.devto.status).toBe("failed");
    expect(by.devto.attempts).toBe(1); // no pointless retries on bad credentials
    expect(by.devto.last_error).toContain("密钥无效");
    expect(by.telegram.status).toBe("done");
    const rec = t.w.texts().find((m) => m.includes("部分发布"))!;
    expect(rec).toContain("dev.to：未成功");
    expect(rec).toContain("/retry");
    // the Chinese original is untouched
    expect((await t.w.DB.prepare("SELECT COUNT(*) n FROM versions").first<any>()).n).toBe(1);
    t.restore();
  });

  it("6 transient dev.to error is retried and succeeds without duplicates", async () => {
    const t = platformWorld();
    t.state.devtoFail = 2;
    await t.w.text(ARTICLE_DEV);
    await t.w.click(t.ap());
    await t.run(15);
    const by = Object.fromEntries((await t.jobs()).map((j) => [j.platform, j]));
    expect(by.devto.status).toBe("done");
    expect(t.state.devto.length).toBe(1);
    t.restore();
  });

  it("9 Bluesky app password revoked -> fails fast with a clear message", async () => {
    const t = platformWorld();
    t.state.bskyAuthFail = true;
    await t.w.text(QUICK);
    await t.w.click(t.ap());
    await t.run(4);
    const bs = (await t.jobs()).find((j) => j.platform === "bluesky");
    expect(bs.status).toBe("failed");
    expect(bs.last_error).toContain("应用密码失效");
    t.restore();
  });

  it("2+8 editing a published article: new version, cache reused for unchanged text, external copies synced in place", async () => {
    const t = platformWorld();
    await t.w.text(ARTICLE_DEV);
    await t.w.click(t.ap());
    await t.run(15);
    const a = await t.art();
    expect(a.status).toBe("published");
    const sends = t.state.chanSends, creates = t.state.bskyCreates, posts = t.state.devtoPosts;
    const calls = t.w.deepl.translateCalls;
    // edit Chinese
    await t.w.text(`/edit ${a.id}`);
    await t.w.text("用 Astro 做双语博客\n我用 `npm create astro` 建站（修订），然后写 TypeScript 代码部署到 Cloudflare Pages。\n\n```ts\nconsole.log(2)\n```");
    expect(t.w.deepl.translateCalls).toBe(calls + 1);
    expect((await t.w.DB.prepare("SELECT COUNT(*) n FROM versions").first<any>()).n).toBe(2);
    const card = t.w.texts().filter((m) => m.includes("待审核")).at(-1)!;
    expect(card).toContain("需同步更新");
    expect(card).toContain("Bluesky 不能编辑");
    await t.w.click(t.ap());
    await t.run(15);
    expect(t.state.chanSends).toBe(sends); // edited, not re-sent
    expect(t.state.chanEdits).toBeGreaterThanOrEqual(2);
    expect(t.state.bskyCreates).toBe(creates); // never reposted
    expect(t.state.devtoPosts).toBe(posts);
    expect(t.state.devtoPuts).toBe(1);
    expect(t.state.devto[0].body_markdown).toContain("console.log(2)");
    // same Chinese again -> no new version, no DeepL call
    await t.w.text(`/edit ${a.id}`);
    await t.w.text("用 Astro 做双语博客\n我用 `npm create astro` 建站（修订），然后写 TypeScript 代码部署到 Cloudflare Pages。\n\n```ts\nconsole.log(2)\n```");
    expect(t.w.deepl.translateCalls).toBe(calls + 1);
    t.restore();
  });

  it("10 DeepL quota too low stops safely before any publishing, original kept", async () => {
    const t = platformWorld();
    t.w.deepl.used = t.w.deepl.limit - 10;
    await t.w.text(QUICK);
    const a = await t.art();
    expect(a.status).toBe("translation_paused");
    expect(t.w.deepl.translateCalls).toBe(0);
    expect((await t.jobs()).length).toBe(0);
    expect((await t.w.DB.prepare("SELECT body_zh FROM versions").first<any>()).body_zh).toBe(QUICK);
    t.restore();
  });
});
