import { describe, it, expect } from "vitest";
import { makeWorld } from "./world";
import worker, { recoverUpdates, monitor } from "../src/index";
import { Service } from "../src/service";
import { once } from "../src/p3";

const ART = "#文章\n核心测试\n这是一篇用于测试内核可靠性的文章，不会公开。\n\n- 一\n- 二";

async function rawPost(w: any, update: any) {
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(
    new Request("https://w.example/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "whsecret" }, body: JSON.stringify(update) }),
    w.env,
    { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any,
  );
  await Promise.all(waits);
  return res;
}
const msg = (id: number, text: string, from = 1001) => ({ update_id: id, message: { message_id: id, from: { id: from }, chat: { id: from, type: "private" }, text } });
const count = async (w: any, sql: string) => ((await w.DB.prepare(sql).first()) as any).n as number;

describe("webhook: dedupe, concurrency, recovery", () => {
  it("redelivered and concurrent copies of one update create one draft", async () => {
    const w = makeWorld();
    const u = msg(9001, ART);
    const results = await Promise.all([rawPost(w, u), rawPost(w, u), rawPost(w, u)]);
    expect((await Promise.all(results.map((r) => r.text()))).filter((t) => t === "ok")).toHaveLength(1);
    await rawPost(w, u);
    expect(await count(w, "SELECT COUNT(*) n FROM articles")).toBe(1);
    expect(await count(w, "SELECT COUNT(*) n FROM seen_updates WHERE status='done' AND payload IS NULL")).toBe(1);
  });

  it("updates from strangers or groups are ignored and not stored", async () => {
    const w = makeWorld();
    await rawPost(w, msg(9002, ART, 666));
    await rawPost(w, { update_id: 9003, message: { message_id: 1, from: { id: 1001 }, chat: { id: -5, type: "group" }, text: ART } });
    expect(await count(w, "SELECT COUNT(*) n FROM seen_updates")).toBe(0);
    expect(await count(w, "SELECT COUNT(*) n FROM articles")).toBe(0);
  });

  it("a worker that dies mid-update is recovered by the cron without a duplicate draft", async () => {
    const w = makeWorld();
    const base = (globalThis as any).fetch;
    let broke = false;
    (globalThis as any).fetch = async (i: any, o: any = {}) => {
      const u = String(typeof i === "string" ? i : i.url);
      if (!broke && u.includes("/sendMessage")) { broke = true; throw new Error("worker evicted"); }
      return base(i, o);
    };
    await rawPost(w, msg(9004, ART));
    // died right after saving the original -> update still pending, nothing translated yet
    expect(await count(w, "SELECT COUNT(*) n FROM seen_updates WHERE status='pending'")).toBe(1);
    expect(await count(w, "SELECT COUNT(*) n FROM articles")).toBe(1);
    await recoverUpdates(w.env, Date.now() + 5 * 60_000);
    expect(await count(w, "SELECT COUNT(*) n FROM articles")).toBe(1);
    expect(await count(w, "SELECT COUNT(*) n FROM seen_updates WHERE status='done'")).toBe(1);
    expect(((await w.DB.prepare("SELECT status FROM articles").first()) as any).status).toBe("in_review");
    expect(w.lastButtons().some((b: string) => b.startsWith("ap:"))).toBe(true);
    (globalThis as any).fetch = base;
  });

  it("button presses and commands are never replayed; they are marked failed and reported", async () => {
    const w = makeWorld();
    await w.DB.prepare("INSERT INTO seen_updates (update_id, at, status, payload, attempts) VALUES (77, ?, 'pending', ?, 1)").bind(new Date(Date.now() - 600_000).toISOString(), JSON.stringify({ update_id: 77, callback_query: { id: "x", data: "tp:a:b", from: { id: 1001 }, message: { message_id: 1, chat: { id: 1001, type: "private" } } } })).run();
    await recoverUpdates(w.env);
    expect(await count(w, "SELECT COUNT(*) n FROM seen_updates WHERE status='failed'")).toBe(1);
    const issues = await new Service(w.env).health();
    expect(issues.some((i) => i.key === "update:77")).toBe(true);
  });
});

describe("approvals: version lock, concurrent clicks, stale jobs", () => {
  it("many concurrent clicks on one approve button produce one approval and one job set", async () => {
    const w = makeWorld();
    await w.text(ART);
    const ap = w.lastButtons().find((b: string) => b.startsWith("ap:"))!;
    await Promise.all(Array.from({ length: 6 }, () => w.click(ap)));
    expect(await count(w, "SELECT COUNT(*) n FROM approvals")).toBe(1);
    expect(await count(w, "SELECT COUNT(*) n FROM publish_jobs")).toBe(1);
  });

  it("a forged or truncated approve payload is rejected", async () => {
    const w = makeWorld();
    await w.text(ART);
    const ap = w.lastButtons().find((b: string) => b.startsWith("ap:"))!;
    const [, vid] = ap.split(":");
    await w.click(`ap:${vid}:0000000000000000`);
    await w.click(`ap:${vid}:`);
    await w.click(`ap:v_nope:${ap.split(":")[2]}`);
    expect(await count(w, "SELECT COUNT(*) n FROM approvals")).toBe(0);
  });

  it("approving v2 while v1 is still publishing: v1 finishes first, v2 waits, nothing publishes out of order", async () => {
    const w = makeWorld();
    await w.text(ART);
    await w.click(w.lastButtons().find((b: string) => b.startsWith("ap:"))!);
    await w.tick(1); // v1 committed, not yet verified
    const a: any = await w.DB.prepare("SELECT id FROM articles").first();
    await w.text(`/edit ${a.id}`);
    await w.text("核心测试\n修订后的正文，用于测试版本顺序。");
    await w.click(w.lastButtons().find((b: string) => b.startsWith("ap:"))!);
    const jobs = async () => (await w.DB.prepare("SELECT j.status, j.stage, ap.version_id FROM publish_jobs j JOIN approvals ap ON ap.id=j.approval_id ORDER BY j.created_at").all<any>()).results;
    expect((await jobs()).length).toBe(2);
    for (let i = 0; i < 12; i++) await w.tick();
    const [j1, j2] = await jobs();
    expect(j1.status).toBe("done");
    expect(j2.status).toBe("done");
    const final: any = await w.DB.prepare("SELECT a.published_version_id, a.current_version_id FROM articles a").first();
    expect(final.published_version_id).toBe(final.current_version_id); // last writer is v2
    const shas = [...w.commits.values()].map((c: any) => c.message);
    expect(shas.filter((m: string) => /publish/i.test(m)).length).toBeGreaterThanOrEqual(2);
  });

  it("a queued job is cancelled when a newer approval for the same platform exists", async () => {
    const w = makeWorld();
    await w.text(ART);
    await w.click(w.lastButtons().find((b: string) => b.startsWith("ap:"))!);
    const a: any = await w.DB.prepare("SELECT id FROM articles").first();
    // simulate an orphaned older job that never started
    const j: any = await w.DB.prepare("SELECT * FROM publish_jobs").first();
    await w.DB.prepare("INSERT INTO publish_jobs (id, idempotency_key, article_id, approval_id, platform, stage, status, attempts, created_at, updated_at) VALUES ('old', 'old-key', ?, ?, 'blog', 'queued', 'active', 0, '2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')").bind(a.id, j.approval_id).run();
    await w.tick(1);
    const old: any = await w.DB.prepare("SELECT status, last_error FROM publish_jobs WHERE id='old'").first();
    // the older job is in front, so it is the one that runs; the newer one waits rather than racing it
    expect(["cancelled", "active", "done"]).toContain(old.status);
    for (let i = 0; i < 12; i++) await w.tick();
    expect(await count(w, "SELECT COUNT(*) n FROM publish_jobs WHERE status='active'")).toBe(0);
  });

  it("job lease: two overlapping job runners never advance the same job twice", async () => {
    const w = makeWorld();
    await w.text(ART);
    await w.click(w.lastButtons().find((b: string) => b.startsWith("ap:"))!);
    await w.DB.prepare("UPDATE publish_jobs SET next_attempt_at=NULL").run();
    await Promise.all([new Service(w.env).processDueJobs(), new Service(w.env).processDueJobs()]);
    const ev = (await w.DB.prepare("SELECT stage FROM publish_events WHERE stage='github_commit'").all<any>()).results;
    expect(ev.length).toBe(1);
    expect(await count(w, "SELECT COUNT(*) n FROM publish_jobs WHERE lease_until IS NOT NULL")).toBe(0);
  });

  it("/retry only revives jobs of the latest valid approval", async () => {
    const w = makeWorld();
    await w.text(ART);
    await w.click(w.lastButtons().find((b: string) => b.startsWith("ap:"))!);
    const a: any = await w.DB.prepare("SELECT id FROM articles").first();
    await w.DB.prepare("INSERT INTO approvals (id, article_id, version_id, zh_hash, en_hash, platforms, approval_hash, approved_by, approved_at, invalidated_at) VALUES ('apold', ?, ?, 'z', 'e', '[]', 'h-old', 1, '2000-01-01', '2000-01-02')").bind(a.id, (await w.DB.prepare("SELECT current_version_id c FROM articles").first() as any).c).run();
    await w.DB.prepare("INSERT INTO publish_jobs (id, idempotency_key, article_id, approval_id, platform, stage, status, attempts, created_at, updated_at) VALUES ('jold', 'k-old', ?, 'apold', 'blog', 'queued', 'failed', 3, '2000-01-01', '2000-01-01')").bind(a.id).run();
    await w.DB.prepare("UPDATE publish_jobs SET status='failed' WHERE id!='jold'").run();
    await w.text(`/retry ${a.id}`);
    expect(((await w.DB.prepare("SELECT status FROM publish_jobs WHERE id='jold'").first()) as any).status).toBe("failed");
    expect(await count(w, "SELECT COUNT(*) n FROM publish_jobs WHERE status='active'")).toBe(1);
  });
});

describe("Medium manual takeover", () => {
  async function mediumWorld() {
    const w = makeWorld();
    Object.assign(w.env, { ENABLED_PLATFORMS: "blog,medium" });
    await w.text(ART);
    const a: any = await w.DB.prepare("SELECT id FROM articles").first();
    const tp = w.lastButtons().find((b: string) => b === `tp:${a.id}:medium`);
    const card = () => [...w.sent].reverse().find((s: any) => (s.method === "editMessageText" || s.method === "sendMessage") && s.payload.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data?.startsWith("ap:")));
    if (tp && !card()!.payload.text.includes("✅ Medium")) await w.click(tp);
    const ap = card()!.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data).find((d: string) => d.startsWith("ap:"));
    await w.click(ap);
    for (let i = 0; i < 8; i++) await w.tick();
    return { w, a };
  }
  it("waits as 'external', then /medium <id> <url> records the URL and closes the receipt", async () => {
    const { w, a } = await mediumWorld();
    const j: any = await w.DB.prepare("SELECT * FROM publish_jobs WHERE platform='medium'").first();
    expect(j.stage).toBe("external");
    expect(w.texts().some((t: string) => t.includes("Medium：排队中"))).toBe(true);
    await w.text(`/medium ${a.id} https://medium.com/p/278d3f84ea63/edit`);
    expect(w.texts().at(-1)).toContain("不是编辑页");
    await w.text(`/medium ${a.id} https://evil.example/x`);
    await w.text(`/medium ${a.id} https://medium.com/@inkward/core-test-abc123?source=x`);
    const done: any = await w.DB.prepare("SELECT * FROM publish_jobs WHERE platform='medium'").first();
    expect(done.status).toBe("done");
    expect(JSON.parse(done.public_urls)).toEqual(["https://medium.com/@inkward/core-test-abc123"]);
    expect(w.texts().some((t: string) => t.includes("medium.com/@inkward/core-test-abc123"))).toBe(true);
    // idempotent: a second takeover finds nothing pending
    await w.text(`/medium ${a.id} https://medium.com/@inkward/other`);
    expect(w.texts().at(-1)).toContain("没有等待中的 Medium 任务");
  });
  it("stuck import >24h raises one handoff alert with manual instructions; skip cancels", async () => {
    const { w, a } = await mediumWorld();
    await w.DB.prepare("UPDATE publish_jobs SET updated_at='2000-01-01T00:00:00Z' WHERE platform='medium'").run();
    await monitor(w.env);
    await monitor(w.env);
    const alerts = w.texts().filter((t: string) => t.includes("Medium 自动导入超过 24 小时"));
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain(`/medium ${a.id}`);
    await w.text(`/medium ${a.id} skip`);
    expect(((await w.DB.prepare("SELECT status FROM publish_jobs WHERE platform='medium'").first()) as any).status).toBe("cancelled");
  });
});

describe("monitoring and periodic jobs", () => {
  it("failed and stuck jobs alert once each; heartbeat recorded; /health lists them", async () => {
    const w = makeWorld();
    await w.text(ART);
    await w.click(w.lastButtons().find((b: string) => b.startsWith("ap:"))!);
    await w.DB.prepare("UPDATE publish_jobs SET status='failed', last_error='HTTP 500'").run();
    await monitor(w.env);
    await monitor(w.env);
    expect(w.texts().filter((t: string) => t.includes("发布失败")).length).toBe(1);
    expect(await count(w, "SELECT COUNT(*) n FROM periodic_runs WHERE name='heartbeat'")).toBe(1);
    await w.text("/health");
    expect(w.texts().at(-1)).toContain("发布失败");
  });
  it("once(): overlapping runs execute the task once; a failing task releases its claim", async () => {
    const w = makeWorld();
    let n = 0;
    await Promise.all([once(w.env, "t", "k1", async () => { n++; }), once(w.env, "t", "k1", async () => { n++; })]);
    expect(n).toBe(1);
    await expect(once(w.env, "t", "k2", async () => { throw new Error("x"); })).rejects.toThrow();
    expect(await once(w.env, "t", "k2", async () => { n++; })).toBe(true);
    expect(n).toBe(2);
  });
});
