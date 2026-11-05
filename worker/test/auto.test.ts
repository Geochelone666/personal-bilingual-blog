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
