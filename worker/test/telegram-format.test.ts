import { describe, it, expect } from "vitest";
import { mdToTgHtml, telegramMessages } from "../src/platforms";

const base = { articleId: "a", titleZh: "标题", titleEn: "Title", zhUrl: "https://b/zh/", enUrl: "https://b/en/" };
describe("telegram bilingual format", () => {
  it("converts markdown safely", () => {
    expect(mdToTgHtml("## H\n**b** <x> [l](https://u)\n```\na<b\n```")).toBe('<b>H</b>\n<b>b</b> &lt;x&gt; <a href="https://u">l</a>\n<pre>a&lt;b</pre>');
  });
  it("one message when short, Chinese first then English", () => {
    const m = telegramMessages({ ...base, bodyZh: "中文正文", bodyEn: "English body" });
    expect(m.length).toBe(1);
    expect(m[0].indexOf("中文正文")).toBeLessThan(m[0].indexOf("English body"));
  });
  it("splits long posts under the limit, zh chunks before en", () => {
    const m = telegramMessages({ ...base, bodyZh: Array(40).fill("段落".repeat(60)).join("\n\n"), bodyEn: Array(40).fill("para ".repeat(40)).join("\n\n") });
    expect(m.length).toBeGreaterThan(2);
    expect(m.every((x) => x.length <= 3900)).toBe(true);
    expect(m[0]).toContain("<b>标题</b>");
    expect(m.findIndex((x) => x.includes("<b>Title</b>"))).toBeGreaterThan(0);
  });
});
