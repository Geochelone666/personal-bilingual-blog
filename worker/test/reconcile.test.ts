import { describe, it, expect } from "vitest";
import { makeWorld } from "./world";
import { reconcile } from "../src/reconcile";

describe("remote reconciliation (read-only)", () => {
  it("flags missing remote copies and dev.to duplicates, and never writes remotely", async () => {
    const w = makeWorld();
    Object.assign(w.env, { DEVTO_API_KEY: "k", BLUESKY_HANDLE: "me.bsky.social" });
    const ins = (id: string, p: string, urls: string[], remote: any) =>
      w.DB.prepare("INSERT INTO publish_jobs (id, idempotency_key, article_id, approval_id, platform, stage, status, attempts, public_urls, remote_id, created_at, updated_at) VALUES (?,?,?,?,?, 'verified','done',0,?,?, '2026-01-01','2026-01-01')").bind(id, id, "a1", "ap1", p, JSON.stringify(urls), remote ? JSON.stringify(remote) : null).run();
    w.DB.raw.exec("PRAGMA foreign_keys=OFF");
    await ins("j1", "blog", ["https://site/zh/posts/x/", "https://site/en/posts/x/"], null);
    await ins("j2", "telegram", ["https://t.me/c/1"], { chat: "@c", ids: [1, 2] });
    await ins("j3", "bluesky", ["https://bsky.app/x"], { rkeys: ["aaa", "bbb"] });
    await ins("j4", "devto", ["https://dev.to/me/x"], { id: 5 });
    await ins("j5", "medium", ["https://medium.com/@me/x"], null);
    const writes: string[] = [];
    const f = (async (i: any, o: any = {}) => {
      const u = new URL(String(i));
      const m = (o.method ?? "GET").toUpperCase();
      if (u.host === "site") return new Response("", { status: u.pathname.startsWith("/en") ? 404 : 200 });
      if (u.host === "api.telegram.org") {
        const b = JSON.parse(o.body);
        if (!u.pathname.endsWith("/editMessageReplyMarkup")) writes.push(u.pathname);
        return new Response(JSON.stringify({ ok: false, description: b.message_id === 2 ? "Bad Request: message to edit not found" : "Bad Request: message is not modified" }), { status: 400 });
      }
      if (u.host === "public.api.bsky.app") return new Response("{}", { status: u.searchParams.get("rkey") === "bbb" ? 400 : 200 });
      if (u.host === "dev.to" && u.pathname === "/api/articles/me/all") return new Response(JSON.stringify([{ canonical_url: "https://site/en/posts/x/" }, { canonical_url: "https://site/en/posts/x/" }]));
      if (u.host === "dev.to") return new Response("", { status: 200 });
      if (m !== "GET") writes.push(String(i));
      return new Response("", { status: 599 });
    }) as any;
    const r = await reconcile(w.env, f);
    expect(r.checked).toBe(4);
    const t = r.problems.map((p) => p.text).join("\n");
    expect(t).toContain("/en/posts/x/ HTTP 404");
    expect(t).toContain("消息 2 不存在");
    expect(t).toContain("帖子 bbb");
    expect(t).toContain("dev.to 上同一篇文章有 2 份");
    expect(t).not.toContain("medium");
    expect(writes).toEqual([]);
  });
});
