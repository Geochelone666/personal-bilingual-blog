import { describe, it, expect } from "vitest";
import { cleanPath, cleanReferrer, weekKey, torontoParts, isBot, buildBackup } from "../src/p3";
import { fixSentenceSpacing } from "../src/util";

describe("p3", () => {
  it("accepts only blog paths", () => {
    expect(cleanPath("/zh/posts/2026-11-05-x/")).toBe("/zh/posts/2026-11-05-x/");
    expect(cleanPath("/en/?utm=1")).toBe("/en/");
    expect(cleanPath("/etc/passwd")).toBeNull();
    expect(cleanPath("https://evil")).toBeNull();
    expect(cleanPath("/zh/<script>/")).toBeNull();
  });
  it("keeps only external referrer hosts", () => {
    expect(cleanReferrer("www.Google.com")).toBe("google.com");
    expect(cleanReferrer("personal-bilingual-blog.pages.dev")).toBe("");
    expect(cleanReferrer("bad host!")).toBe("");
  });
  it("computes ISO weeks", () => {
    expect(weekKey(new Date("2026-11-09T15:00:00Z"))).toBe("2026-W46");
    expect(weekKey(new Date("2027-01-01T15:00:00Z"))).toBe("2026-W53");
  });
  it("fixes run-together sentences", () => {
    expect(fixSentenceSpacing("progress.Technological way.The x.)With")).toBe("progress. Technological way. The x.) With");
    expect(fixSentenceSpacing("3.5 and e.g. fine")).toBe("3.5 and e.g. fine");
  });
  it("Toronto wall clock across DST", () => {
    expect(torontoParts(new Date("2026-11-02T14:30:00Z"))).toMatchObject({ weekday: 1, hour: 9 }); // EST
    expect(torontoParts(new Date("2026-10-26T13:30:00Z"))).toMatchObject({ weekday: 1, hour: 9 }); // EDT
    expect(torontoParts(new Date("2026-11-03T03:00:00Z"))).toMatchObject({ weekday: 1, hour: 22 }); // still Monday locally
  });
  it("filters bots", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isBot("Mozilla/5.0 HeadlessChrome/120")).toBe(true);
    expect(isBot(null)).toBe(true);
    expect(isBot("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36")).toBe(false);
  });
});

describe("public content backup", () => {
  it("queries only published versions and excludes drafts, private metadata and pending jobs", async () => {
    const queries: string[] = [];
    const fakeDb = {
      prepare(sql: string) {
        queries.push(sql);
        return { all: async () => ({ results: [] }) };
      },
    };
    const output = JSON.parse(await buildBackup({ DB: fakeDb } as any));
    expect(output).toEqual({ articles: [], versions: [], publish_jobs: [] });
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain("published_version_id IS NOT NULL");
    expect(queries[1]).toContain("a.published_version_id = v.id");
    expect(queries[2]).toContain("j.status='done'");
    expect(queries.join(" ")).not.toMatch(/SELECT \* FROM glossary|created_by|current_version_id|last_error|review_sent_for/i);
  });

  it("backs up exactly the public published version, not a later review draft", async () => {
    const calls = [
      [{ id: "published", published_version_id: "version1" }],
      [{ id: "version1", body_zh: "public" }],
      [{ article_id: "published", platform: "blog", public_urls: '["https://example.com"]' }],
    ];
    let index = 0;
    const fakeDb = { prepare: () => ({ all: async () => ({ results: calls[index++] }) }) };
    const output = JSON.parse(await buildBackup({ DB: fakeDb } as any));
    expect(output.versions).toEqual([{ id: "version1", body_zh: "public" }]);
    expect(output).not.toHaveProperty("glossary");
  });
});

describe("public content backup (real schema)", () => {
  it("after publishing v1 and editing to an unapproved v2, only v1 is exported", async () => {
    const { makeWorld } = await import("./world");
    const w = makeWorld();
    await w.text("#文章\n公开标题\n这是已经公开的正文，用来测试备份。\n\n- 第一点\n- 第二点");
    await w.click(w.lastButtons().find((b) => b.startsWith("ap:"))!);
    await w.tick(6);
    const a: any = await w.DB.prepare("SELECT id, status FROM articles").first();
    expect(a.status).toBe("published");
    await w.text(`/edit ${a.id}`);
    await w.text("公开标题\n这是尚未审核的私人修订草稿 SECRET-DRAFT。");
    await w.text("#想法\n未批准的短想法 SECRET-QUICK");
    const out = await buildBackup(w.env);
    expect(out).not.toContain("SECRET-DRAFT");
    expect(out).not.toContain("SECRET-QUICK");
    const j = JSON.parse(out);
    expect(j.articles.map((x: any) => x.id)).toEqual([a.id]);
    expect(j.versions).toHaveLength(1);
    expect(j.versions[0].body_zh).toContain("已经公开的正文");
    expect(out).not.toMatch(/created_by|approved_by|7704621098|telegram_user/);
  });
});
