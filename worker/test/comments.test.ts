import { describe, it, expect } from "vitest";
import { makeWorld } from "./world";
import { handleComments, deleteComment } from "../src/comments";

const PROD = "https://personal-bilingual-blog.pages.dev";
const STG = "https://staging.personal-bilingual-blog.pages.dev";
function req(method: string, origin: string | null, body?: any, ip = "1.2.3.4", q = "") {
  const h: Record<string, string> = { "CF-Connecting-IP": ip, "Content-Type": "application/json" };
  if (origin) h.Origin = origin;
  const url = new URL("https://w.dev/comments" + q);
  return [new Request(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), url] as const;
}
async function call(w: any, ...a: Parameters<typeof req>) { const [r, u] = req(...a); const res = await handleComments(r, u, w.env); return { status: res.status, j: await res.json().catch(() => null) as any }; }

describe("comments", () => {
  it("anyone can comment, nickname optional, shows immediately", async () => {
    const w = makeWorld(); w.env.SITE_URL = PROD;
    const a = await call(w, "POST", PROD, { s: "my-post", body: "  写得好！ " });
    expect(a.status).toBe(201);
    expect(a.j.comment.name).toBe("");
    const b = await call(w, "POST", PROD, { s: "my-post", name: "小明", body: "同意" }, "5.6.7.8");
    expect(b.status).toBe(201);
    const g = await call(w, "GET", PROD, undefined, "9.9.9.9", "?s=my-post");
    expect(g.j.comments.map((c: any) => [c.name, c.body])).toEqual([["", "写得好！"], ["小明", "同意"]]);
    expect(g.j.comments[0].ip_hash).toBeUndefined();
  });

  it("staging comments never reach the live blog; unknown origins are refused", async () => {
    const w = makeWorld(); w.env.SITE_URL = PROD;
    await call(w, "POST", STG, { s: "p", body: "test" });
    expect((await call(w, "GET", PROD, undefined, "1.1.1.1", "?s=p")).j.comments).toEqual([]);
    expect((await call(w, "GET", STG, undefined, "1.1.1.1", "?s=p")).j.comments.length).toBe(1);
    expect((await call(w, "POST", "https://evil.example", { s: "p", body: "x" })).status).toBe(403);
    expect((await call(w, "POST", null, { s: "p", body: "x" })).status).toBe(403);
  });

  it("limits: empty, too long, bad slug, honeypot, rate, duplicate", async () => {
    const w = makeWorld(); w.env.SITE_URL = PROD;
    expect((await call(w, "POST", PROD, { s: "p", body: "   " })).status).toBe(400);
    expect((await call(w, "POST", PROD, { s: "../x", body: "hi" })).status).toBe(400);
    expect((await call(w, "POST", PROD, { s: "p", body: "spam", website: "x" })).status).toBe(200);
    const long = await call(w, "POST", PROD, { s: "p", name: "n".repeat(99), body: "字".repeat(5000).slice(0, 1500) });
    expect(long.status).toBe(201);
    expect(long.j.comment.body.length).toBe(1000);
    expect(long.j.comment.name.length).toBe(30);
    expect((await call(w, "POST", PROD, { s: "p", body: "again" })).status).toBe(429);
    w.DB.raw.prepare("UPDATE comments SET created_at=?").run(new Date(Date.now() - 60_000).toISOString());
    expect((await call(w, "POST", PROD, { s: "p", body: "字".repeat(1000) })).status).toBe(409);
    expect((await call(w, "POST", PROD, { s: "p", body: "different" })).status).toBe(201);
    const n = (w.DB.raw.prepare("SELECT COUNT(*) n FROM comments WHERE body='spam'").get() as any).n;
    expect(n).toBe(0);
  });

  it("owner can delete", async () => {
    const w = makeWorld(); w.env.SITE_URL = PROD;
    const a = await call(w, "POST", PROD, { s: "p", body: "bad" });
    expect(await deleteComment(w.env, a.j.comment.id)).toBe(true);
    expect((await call(w, "GET", PROD, undefined, "2.2.2.2", "?s=p")).j.comments).toEqual([]);
  });
});
