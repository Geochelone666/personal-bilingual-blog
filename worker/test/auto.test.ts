import { describe, it, expect } from "vitest";
import { makeWorld } from "./world";
import { userTitle, heuristicTitle } from "../src/autotitle";

describe("auto publish mode", () => {
  it("title detection", () => {
    expect(userTitle("复古男孩\n正文第一段。")?.title).toBe("复古男孩");
    expect(userTitle("我是一个计算机学生，为什么要做blog呢？因为想要搞一些复古的东西。")).toBeNull();
    expect(userTitle("今天天气很好。\n第二段")).toBeNull();
    expect(heuristicTitle("我是一个计算机学生，为什么要做blog呢？")).toBe("我是一个计算机学生");
  });

  it("one plain message -> published, one concise receipt with links, no buttons", async () => {
    const w = makeWorld();
    w.env.AUTO_PUBLISH = "true";
    w.env.AI = { run: async () => ({ response: "前沿的复古男孩" }) };
    await w.text("我是一个计算机学生，为什么要做blog呢？因为想要搞一些复古的东西。总而言之，我也享受编程的乐趣。");
    expect(w.sent.some((s) => s.payload.reply_markup)).toBe(false);
    await w.tick(4);
    const a: any = await w.DB.prepare("SELECT * FROM articles").first();
    expect(a.status).toBe("published");
    const v: any = await w.DB.prepare("SELECT title_zh FROM versions").first();
    expect(v.title_zh).toBe("前沿的复古男孩");
    const msgs = w.texts();
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain("✅ 《前沿的复古男孩》已发布");
    expect(msgs[0]).toContain('<a href="');
    await w.tick(3);
    expect(w.texts().length).toBe(1);
  });

  it("long message split by Telegram is joined into one post", async () => {
    const w = makeWorld();
    w.env.AUTO_PUBLISH = "true";
    const part1 = "长".repeat(4000);
    await w.text(part1);
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM articles").first<any>()).n).toBe(0);
    await w.text("结尾。");
    const r: any = await w.DB.prepare("SELECT body_zh FROM versions").first();
    expect(r.body_zh.length).toBe(4003);
  });
});

describe("P1 cross-posting", () => {
  it("blog first, then Telegram channel + dev.to; one combined receipt; failures marked 未成功", async () => {
    const w = makeWorld();
    Object.assign(w.env, { AUTO_PUBLISH: "true", ENABLED_PLATFORMS: "blog,telegram,devto,bluesky", TELEGRAM_CHANNEL: "@chan", DEVTO_API_KEY: "k" });
    const base = (globalThis as any).fetch;
    let devtoPosts = 0;
    let chanPosts = 0;
    (globalThis as any).fetch = async (input: any, init: any = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.host === "dev.to") {
        if (url.pathname === "/api/articles/me/all") return new Response("[]", { status: 200 });
        devtoPosts++;
        return new Response(JSON.stringify({ error: "boom" }), { status: 422 });
      }
      if (url.host === "api.telegram.org" && url.pathname.endsWith("/sendMessage")) {
        const b = JSON.parse(init.body);
        if (b.chat_id === "@chan") {
          chanPosts++;
          return new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: -1001, username: "chan" } } }));
        }
      }
      return base(input, init);
    };
    await w.text("标题\n正文内容。");
    const jobs = (await w.DB.prepare("SELECT platform FROM publish_jobs ORDER BY platform").all<any>()).results.map((j: any) => j.platform);
    expect(jobs).toEqual(["blog", "devto", "telegram"]); // bluesky not configured -> not enabled
    for (let i = 0; i < 40; i++) {
      await w.DB.prepare("UPDATE publish_jobs SET next_attempt_at=NULL").run();
      await w.tick();
    }
    expect(chanPosts).toBe(1);
    expect(devtoPosts).toBeGreaterThan(1); // retried
    const rec = w.texts().filter((t) => t.includes("《标题》"));
    expect(rec.length).toBe(1);
    expect(rec[0]).toContain("⚠️ 《标题》部分发布");
    expect(rec[0]).toContain('Telegram 频道：<a href="https://t.me/chan/7">');
    expect(rec[0]).toContain("dev.to：未成功");
    (globalThis as any).fetch = base;
  });
});
