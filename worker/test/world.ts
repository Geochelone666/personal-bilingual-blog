import { makeD1 } from "./d1shim";
import worker from "../src/index";
import type { Env } from "../src/env";

/** A fake outside world: Telegram, DeepL Free, GitHub, Cloudflare Pages and the public blog. */
export function makeWorld(opts: { deeplLimit?: number; deeplUsed?: number; deeplKey?: string } = {}) {
  const sent: Array<{ method: string; payload: any }> = [];
  const calls: string[] = [];
  const deepl = { used: opts.deeplUsed ?? 0, limit: opts.deeplLimit ?? 500000, translateCalls: 0 };
  // git: commits map sha -> {parent, files}
  const commits = new Map<string, { parent: string | null; files: Record<string, string>; message: string }>();
  commits.set("c0", { parent: null, files: {}, message: "init" });
  const heads: Record<string, string> = { staging: "c0", main: "c0" };
  const trees = new Map<string, Record<string, string>>();
  let seq = 0;
  const deployments: Array<{ id: string; sha: string; polls: number; fail?: boolean }> = [];
  const failures = { githubPatch: 0, pagesFailOnce: false };

  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

  const fetcher = async (input: any, init: any = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.host}${url.pathname}`);

    if (url.host === "api.telegram.org") {
      const m = url.pathname.split("/").pop()!;
      const payload = init.body ? JSON.parse(init.body) : {};
      sent.push({ method: m, payload });
      if (m === "getMe") return json({ ok: true, result: { username: "test_bot" } });
      if (m === "getWebhookInfo") return json({ ok: true, result: { url: "x", pending_update_count: 0 } });
      return json({ ok: true, result: { message_id: sent.length } });
    }

    if (url.host === "api-free.deepl.com") {
      if (url.pathname === "/v2/usage") return json({ character_count: deepl.used, character_limit: deepl.limit });
      if (url.pathname === "/v2/translate") {
        deepl.translateCalls++;
        const p = new URLSearchParams(init.body);
        const texts = p.getAll("text");
        deepl.used += texts.reduce((n, t) => n + [...t].length, 0);
        // fake translation: every Chinese run -> "word", keep everything else (placeholders, digits)
        return json({ translations: texts.map((t) => ({ text: t.replace(/[\u4e00-\u9fff，。！？、：；]+/g, " word ").replace(/\s+/g, " ").trim() })) });
      }
    }

    if (url.host === "api.github.com") {
      const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
      const body = init.body ? JSON.parse(init.body) : null;
      if (path.startsWith("/contents/")) {
        const fp = decodeURI(path.slice("/contents/".length));
        const ref = url.searchParams.get("ref")!;
        const c = commits.get(heads[ref]);
        const txt = c?.files[fp];
        if (txt == null) return json({ message: "Not Found" }, 404);
        return json({ content: btoa(String.fromCharCode(...new TextEncoder().encode(txt))) });
      }
      if (path === "/commits") {
        const fp = url.searchParams.get("path")!;
        let sha: string | null = heads[url.searchParams.get("sha")!];
        // newest commit that changed fp
        while (sha) {
          const c = commits.get(sha)!;
          const prev = c.parent ? commits.get(c.parent)!.files[fp] : undefined;
          if (c.files[fp] !== prev) return json([{ sha }]);
          sha = c.parent;
        }
        return json([]);
      }
      if (path.startsWith("/git/ref/heads/")) {
        const b = decodeURIComponent(path.split("/").pop()!);
        return heads[b] ? json({ object: { sha: heads[b] } }) : json({}, 404);
      }
      if (path.startsWith("/git/commits/") && method === "GET") {
        const sha = path.split("/").pop()!;
        return json({ sha, tree: { sha: `t_${sha}` } });
      }
      if (path === "/git/trees" && method === "POST") {
        const baseSha = body.base_tree.replace(/^t_/, "");
        const files = { ...commits.get(baseSha)!.files };
        for (const f of body.tree) files[f.path] = f.content;
        const t = `tree${++seq}`;
        trees.set(t, files);
        return json({ sha: t });
      }
      if (path === "/git/commits" && method === "POST") {
        const sha = `sha${++seq}`;
        commits.set(sha, { parent: body.parents[0], files: trees.get(body.tree)!, message: body.message });
        return json({ sha });
      }
      if (path.startsWith("/git/refs/heads/") && method === "PATCH") {
        if (failures.githubPatch > 0) {
          failures.githubPatch--;
          return json({ message: "boom" }, 502);
        }
        const b = decodeURIComponent(path.split("/").pop()!);
        heads[b] = body.sha;
        deployments.push({ id: `dep_${body.sha}`, sha: body.sha, polls: 0, fail: failures.pagesFailOnce });
        failures.pagesFailOnce = false;
        return json({ object: { sha: body.sha } });
      }
      return json({ full_name: "o/r", private: true, permissions: { push: true } });
    }

    if (url.host === "api.cloudflare.com") {
      if (url.pathname.endsWith("/retry")) {
        const id = url.pathname.split("/").at(-2)!;
        const d = deployments.find((x) => x.id === id)!;
        d.fail = false;
        d.polls = 0;
        return json({ success: true });
      }
      if (url.pathname.endsWith("/deployments")) {
        return json({
          result: deployments.map((d) => {
            d.polls++;
            const done = d.polls >= 2;
            return {
              id: d.id,
              url: `https://${d.id}.pbb.pages.dev`,
              aliases: ["https://staging.pbb.pages.dev"],
              deployment_trigger: { metadata: { commit_hash: d.sha } },
              latest_stage: d.fail && done ? { name: "build", status: "failure" } : done ? { name: "deploy", status: "success" } : { name: "build", status: "active" },
            };
          }),
        });
      }
    }

    if (url.host === "staging.pbb.pages.dev" || url.host === "blog.example") {
      // serve the built site from the staging head: /zh/posts/<slug>/
      const m = url.pathname.match(/^\/(zh|en)\/posts\/([^/]+)\/$/);
      const d = deployments.filter((x) => x.polls >= 2 && !x.fail).at(-1);
      const files = d ? commits.get(d.sha)!.files : {};
      const src = m ? files[`blog/src/content/posts/${m[1]}/${m[2]}.md`] : undefined;
      if (!src) return new Response("404", { status: 404 });
      const vh = src.match(/versionHash: "([0-9a-f]+)"/)![1];
      return new Response(`<html><head><meta name="pbb-version" content="${vh}"></head></html>`, { status: 200 });
    }

    return new Response(`unmocked ${url}`, { status: 599 });
  };

  const DB = makeD1();
  const env: Env = {
    DB,
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_WEBHOOK_SECRET: "whsecret",
    DEEPL_API_KEY: opts.deeplKey ?? "key:fx",
    GITHUB_TOKEN: "ghp",
    CF_API_TOKEN: "cf",
    PREVIEW_SIGNING_KEY: "sign",
    ADMIN_TOKEN: "admin",
    ALLOWED_TELEGRAM_USER_IDS: "1001",
    GITHUB_REPO: "o/r",
    GITHUB_BRANCH: "staging",
    CF_ACCOUNT_ID: "acc",
    PAGES_PROJECT: "pbb",
    SITE_URL: "https://blog.example",
    WORKER_URL: "https://w.example",
    PUBLISH_MODE: "preview",
    DEEPL_MIN_REMAINING: "100",
  };

  // route global fetch to the fake world
  (globalThis as any).fetch = fetcher;

  let upd = 1;
  async function post(update: any, secret = "whsecret") {
    const waits: Promise<unknown>[] = [];
    const ctx: any = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
    const res = await worker.fetch(
      new Request("https://w.example/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ update_id: upd++, ...update }) }),
      env,
      ctx,
    );
    await Promise.all(waits);
    return res;
  }
  const text = (t: string, from = 1001) => post({ message: { message_id: upd, from: { id: from }, chat: { id: from, type: "private" }, text: t } });
  const click = (data: string, from = 1001) => post({ callback_query: { id: `cq${upd}`, from: { id: from }, data, message: { message_id: 1, chat: { id: from, type: "private" } } } });
  async function tick(n = 1) {
    for (let i = 0; i < n; i++) {
      DB.raw.prepare("UPDATE publish_jobs SET next_attempt_at=NULL").run();
      const waits: Promise<unknown>[] = [];
      await worker.scheduled({} as any, env, { waitUntil: (p: Promise<unknown>) => waits.push(p) } as any);
      await Promise.all(waits);
    }
  }
  const lastButtons = () => {
    const m = [...sent].reverse().find((s) => s.method === "sendMessage" && s.payload.reply_markup?.inline_keyboard?.length);
    return m?.payload.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data) as string[];
  };
  const texts = () => sent.filter((s) => s.method === "sendMessage").map((s) => s.payload.text as string);
  return { env, DB, sent, calls, deepl, commits, heads, deployments, failures, post, text, click, tick, lastButtons, texts };
}
