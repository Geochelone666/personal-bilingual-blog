import type { Env } from "./env";
import { nowIso } from "./util";

// Reader comments: no account, optional nickname, no approval (user 2026-11-11).
// Abuse limits only: size caps, a honeypot field, and per-IP rate limits.
export const MAX_BODY = 1000;
export const MAX_NAME = 30;
const SLUG = /^[a-z0-9][a-z0-9-]{0,150}$/;

function siteOf(origin: string | null, env: Env): "prod" | "test" | null {
  if (!origin) return null;
  let host: string;
  try { host = new URL(origin).host; } catch { return null; }
  const prod = new URL(env.SITE_URL).host;
  if (host === prod) return "prod";
  if (host.endsWith("." + prod)) return "test"; // staging + branch previews
  return null;
}

function cors(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

async function ipHash(req: Request, env: Env): Promise<string> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const data = new TextEncoder().encode(`${env.PREVIEW_SIGNING_KEY}|comments|${ip}`);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

export async function handleComments(req: Request, url: URL, env: Env): Promise<Response> {
  const origin = req.headers.get("Origin");
  const h = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  const site = siteOf(origin, env);
  const out = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: h });
  if (!site) return out(403, { error: "origin" });

  if (req.method === "GET") {
    const slug = url.searchParams.get("s") ?? "";
    if (!SLUG.test(slug)) return out(400, { error: "slug" });
    const r = await env.DB.prepare("SELECT id, name, body, created_at FROM comments WHERE site=? AND slug=? AND deleted=0 ORDER BY id ASC LIMIT 500")
      .bind(site, slug).all<any>();
    return out(200, { comments: r.results ?? [] });
  }

  if (req.method !== "POST") return out(405, { error: "method" });
  if (Number(req.headers.get("Content-Length") ?? 0) > 8000) return out(413, { error: "too_large" });
  let j: any;
  try { j = await req.json(); } catch { return out(400, { error: "json" }); }
  if (j?.website) return out(200, { ok: true }); // honeypot: pretend success, store nothing
  const slug = String(j?.s ?? "");
  if (!SLUG.test(slug)) return out(400, { error: "slug" });
  const body = clean(j?.body, MAX_BODY);
  const name = clean(j?.name, MAX_NAME).replace(/\n/g, " ");
  if (!body) return out(400, { error: "empty" });

  const ip = await ipHash(req, env);
  const now = Date.now();
  const recent = await env.DB.prepare(
    "SELECT SUM(created_at > ?) a, SUM(created_at > ?) b, COUNT(*) c FROM comments WHERE ip_hash=? AND created_at > ?",
  ).bind(new Date(now - 15_000).toISOString(), new Date(now - 3600_000).toISOString(), ip, new Date(now - 86400_000).toISOString()).first<any>();
  if ((recent?.a ?? 0) >= 1 || (recent?.b ?? 0) >= 10 || (recent?.c ?? 0) >= 30) return out(429, { error: "slow_down" });
  const dup = await env.DB.prepare("SELECT 1 FROM comments WHERE ip_hash=? AND slug=? AND body=? AND deleted=0 LIMIT 1").bind(ip, slug, body).first();
  if (dup) return out(409, { error: "duplicate" });

  const created = nowIso();
  const row = await env.DB.prepare("INSERT INTO comments (site, slug, name, body, ip_hash, created_at) VALUES (?,?,?,?,?,?) RETURNING id")
    .bind(site, slug, name, body, ip, created).first<any>();
  return out(201, { comment: { id: row?.id, name, body, created_at: created } });
}

// Owner-only cleanup, via /admin/comment-delete?id=N (ADMIN_TOKEN).
export async function deleteComment(env: Env, id: number): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE comments SET deleted=1 WHERE id=? AND deleted=0").bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}
