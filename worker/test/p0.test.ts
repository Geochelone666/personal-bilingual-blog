import { describe, it, expect } from "vitest";
import { makeWorld } from "./world";
import { protect, restore } from "../src/protect";
import { approvalHash } from "../src/approval";
import { runQc } from "../src/qc";

const ARTICLE = "关于学习的一点想法\n我觉得每天写 500 字可能比偶尔写长文更有用。\n\n- 第一点：坚持\n- 第二点：复盘\n\n参考 https://example.com/a 和 `code()`。";

describe("unit", () => {
  it("protect/restore keeps code, urls, glossary terms", () => {
    const p = protect("用 `npm i` 安装，见 https://x.y/z 和 [链接](https://a.b)。Astro 很好", [{ term_zh: "很好", term_en: "great" }]);
    expect(p.text).not.toContain("https://");
    expect(restore(p.text, p.slots)).toContain("`npm i`");
    expect(restore(p.text, p.slots)).toContain("great");
  });
  it("approval hash binds version, hashes and platform list", async () => {
    const a = await approvalHash("v1", "zh", "en", ["blog"]);
    expect(await approvalHash("v1", "zh", "en", ["blog"])).toBe(a);
    expect(await approvalHash("v1", "zh", "en", ["blog", "telegram"])).not.toBe(a);
    expect(await approvalHash("v1", "zh2", "en", ["blog"])).not.toBe(a);
    expect(await approvalHash("v1", "zh", "en2", ["blog"])).not.toBe(a);
    expect(await approvalHash("v2", "zh", "en", ["blog"])).not.toBe(a);
  });
  it("QC flags missing numbers and lost hedging", () => {
    const r = runQc("标题", "可能有 30% 的人也许会这样，大概吧。", "Title", "People do this.", []);
    expect(r.issues.map((i) => i.check)).toEqual(expect.arrayContaining(["numbers", "hedging"]));
  });
});

describe("end-to-end (fake Telegram/DeepL/GitHub/Pages)", () => {
  it("rejects bad webhook secret and ignores non-allowlisted users", async () => {
    const w = makeWorld();
    expect((await w.post({ message: { from: { id: 1001 }, chat: { id: 1001, type: "private" }, text: "/help" } }, "wrong")).status).toBe(403);
    await w.text(ARTICLE, 666);
    expect(w.sent.length).toBe(0);
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM articles").first()).n).toBe(0);
    // a stranger cannot approve either
    await w.text(ARTICLE);
    const ap = w.lastButtons().find((b) => b.startsWith("ap:"))!;
    const before = w.sent.length;
    await w.click(ap, 666);
    expect(w.sent.length).toBe(before);
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM approvals").first()).n).toBe(0);
  });

  it("full flow: draft -> translate -> review -> approve -> commit -> deploy -> verify, with 3 distinct receipts", async () => {
    const w = makeWorld();
    await w.text(ARTICLE);
    expect(w.texts().some((t) => t.includes("中文原稿已保存"))).toBe(true);
    expect(w.texts().some((t) => t.includes("待审核"))).toBe(true);
    expect(w.deepl.translateCalls).toBe(1);
    const ap = w.lastButtons().find((b) => b.startsWith("ap:"))!;

    // nothing published before approval
    await w.tick(3);
    expect(w.heads.staging).toBe("c0");

    await w.click(ap);
    await w.click(ap); // double click: idempotent
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM publish_jobs").first()).n).toBe(1);

    await w.tick(); // commit
    await w.tick(); // pages building
    await w.tick(); // pages success
    expect(w.texts().some((t) => t.includes("已发布"))).toBe(false); // no receipt before verification
    await w.tick(); // verify
    const receipts = w.texts().filter((t) => t.includes("》已发布"));
    expect(receipts.length).toBe(1);
    expect(receipts[0]).toContain("/zh/posts/");
    const a = await w.DB.prepare("SELECT * FROM articles").first();
    expect(a.status).toBe("published");
    const ev = (await w.DB.prepare("SELECT stage, ok FROM publish_events ORDER BY id").all()).results.map((e: any) => e.stage);
    expect(ev).toEqual(["github_commit", "pages_deploy", "url_verify", "receipt"]);

    // more cron ticks / clicks never produce a second commit
    const commitsBefore = w.commits.size;
    await w.tick(3);
    await w.click(ap);
    await w.tick(2);
    expect(w.commits.size).toBe(commitsBefore);
  });

  it("editing after preview invalidates the old approval button", async () => {
    const w = makeWorld();
    await w.text(ARTICLE);
    const oldAp = w.lastButtons().find((b) => b.startsWith("ap:"))!;
    const id = (await w.DB.prepare("SELECT id FROM articles").first()).id;
    await w.text(`/edit ${id}`);
    await w.text("关于学习的一点想法（修订）\n新的正文，可能更好。");
    await w.click(oldAp);
    const cb = w.sent.filter((s) => s.method === "answerCallbackQuery").at(-1)!.payload.text;
    expect(cb).toContain("失效");
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM approvals").first()).n).toBe(0);
    // new button works
    const newAp = w.lastButtons().find((b) => b.startsWith("ap:"))!;
    expect(newAp).not.toBe(oldAp);
    await w.click(newAp);
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM approvals").first()).n).toBe(1);
  });

  it("editing English creates a new version and requires re-approval", async () => {
    const w = makeWorld();
    await w.text(ARTICLE);
    const oldAp = w.lastButtons().find((b) => b.startsWith("ap:"))!;
    const id = (await w.DB.prepare("SELECT id FROM articles").first()).id;
    await w.text(`/en ${id}`);
    await w.text("Some thoughts on learning\nWriting 500 words a day might be more useful.");
    await w.click(oldAp);
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM approvals").first()).n).toBe(0);
    const v = await w.DB.prepare("SELECT en_source FROM versions ORDER BY version_no DESC").first();
    expect(v.en_source).toBe("user_edit");
  });

  it("DeepL quota too low -> paused, no translate call, draft kept", async () => {
    const w = makeWorld({ deeplLimit: 500000, deeplUsed: 499990 });
    await w.text(ARTICLE);
    expect(w.deepl.translateCalls).toBe(0);
    expect(w.texts().some((t) => t.includes("翻译已暂停"))).toBe(true);
    const a = await w.DB.prepare("SELECT status FROM articles").first();
    expect(a.status).toBe("translation_paused");
    expect((await w.DB.prepare("SELECT COUNT(*) n FROM versions").first()).n).toBe(1);
  });

  it("refuses non-Free DeepL keys (no :fx)", async () => {
    const w = makeWorld({ deeplKey: "pro-key" });
    await w.text(ARTICLE);
    expect(w.calls.some((c) => c.includes("deepl"))).toBe(false);
    expect(w.texts().some((t) => t.includes("不是 DeepL API Free 密钥"))).toBe(true);
  });

  it("translation cache: retranslate of unchanged text costs 0 chars", async () => {
    const w = makeWorld();
    await w.text(ARTICLE);
    const id = (await w.DB.prepare("SELECT id FROM articles").first()).id;
    await w.text(`/retranslate ${id}`);
    expect(w.deepl.translateCalls).toBe(1);
    const v = await w.DB.prepare("SELECT en_source FROM versions").first();
    expect(v.en_source).toBe("cache");
  });

  it("GitHub failure is retried without duplicate commits; lost DB state reuses the existing commit", async () => {
    const w = makeWorld();
    await w.text(ARTICLE);
    w.failures.githubPatch = 1;
    await w.click(w.lastButtons().find((b) => b.startsWith("ap:"))!);
    await w.tick(); // fails
    let job = await w.DB.prepare("SELECT * FROM publish_jobs").first();
    expect(job.stage).toBe("queued");
    expect(job.attempts).toBe(1);
    await w.tick(); // succeeds
    job = await w.DB.prepare("SELECT * FROM publish_jobs").first();
    expect(job.stage).toBe("committed");
    const head = w.heads.staging;
    // simulate a crash after commit but before the DB update
    w.DB.raw.prepare("UPDATE publish_jobs SET stage='queued', commit_sha=NULL").run();
    await w.tick();
    job = await w.DB.prepare("SELECT * FROM publish_jobs").first();
    expect(job.commit_sha).toBe(head);
    expect(w.heads.staging).toBe(head);
  });

  it("Pages build failure is retried and recovers", async () => {
    const w = makeWorld();
    await w.text(ARTICLE);
    w.failures.pagesFailOnce = true;
    await w.click(w.lastButtons().find((b) => b.startsWith("ap:"))!);
    await w.tick(6);
    const a = await w.DB.prepare("SELECT status FROM articles").first();
    expect(a.status).toBe("published");
    const ev = (await w.DB.prepare("SELECT stage, ok FROM publish_events").all()).results;
    expect(ev.some((e: any) => e.stage === "pages_deploy" && e.ok === 0)).toBe(true);
  });

  it("protected preview requires a valid signature", async () => {
    const w = makeWorld();
    await w.text(ARTICLE);
    const review = w.texts().find((t) => t.includes("完整预览"))!;
    const link = review.match(/https:\/\/w\.example\/preview\/\S+/)![0];
    const worker = (await import("../src/index")).default;
    const ok = await worker.fetch(new Request(link), w.env, {} as any);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("X-Robots-Tag")).toContain("noindex");
    const bad = await worker.fetch(new Request(link.replace(/sig=\w{4}/, "sig=0000")), w.env, {} as any);
    expect(bad.status).toBe(403);
  });
});
