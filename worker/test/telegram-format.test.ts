import { describe, it, expect } from "vitest";
import { mdToTgHtml, telegramMessages } from "../src/platforms";

const base = { articleId: "a", titleZh: "标题", titleEn: "Title", zhUrl: "https://b/zh/", enUrl: "https://b/en/" };
describe("telegram bilingual format", () => {
  it("converts markdown safely", () => {
    expect(mdToTgHtml("## H\n**b** <x> [l](https://u)\n```\na<b\n```")).toBe('<b>H</b>\n<b>b</b> &lt;x&gt; <a href="https://u">l</a>\n<pre>a&lt;b</pre>');
  });
  it("one language per channel, full text + its link", () => {
    const p = { ...base, bodyZh: "中文正文", bodyEn: "English body" };
    const zh = telegramMessages(p, "zh"), en = telegramMessages(p, "en");
    expect(zh).toEqual(['<b>标题</b>\n\n中文正文\n\n<a href="https://b/zh/">博客原文</a>']);
    expect(en[0]).toContain("English body");
    expect(en[0]).not.toContain("中文");
  });
  it("splits long posts under the limit", () => {
    const m = telegramMessages({ ...base, bodyZh: Array(40).fill("段落".repeat(60)).join("\n\n"), bodyEn: "" }, "zh");
    expect(m.length).toBeGreaterThan(1);
    expect(m.every((x) => x.length <= 3900)).toBe(true);
    expect(m[0]).toContain("<b>标题</b>");
  });
});
