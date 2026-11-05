import { Env } from "./env";
import { enabledPlatforms, postTo, PLATFORM_LABEL, PLATFORM_ORDER } from "./platforms";
import { sha256Hex, nowIso, randomId, zhHashInput, normalizeBody, makeSlug, backoffSeconds, addSeconds, hmacHex } from "./util";
import { translateZhToEn, QuotaError, KeyTypeError, deeplUsage } from "./deepl";
import { runQc } from "./qc";
import { approvalHash, checkApproval, canonicalPlatforms, idempotencyKey } from "./approval";
import { Telegram, kb, esc } from "./telegram";
import { GitHub } from "./github";
import { findDeployment, retryDeployment, verifyPublicUrl } from "./pages";
import { renderPostFile, postPath, publicPostUrl } from "./render";

const ENGINE = "deepl-free-v2";
const MAX_JOB_ATTEMPTS = 12;
const PREVIEW_TTL_S = 7 * 24 * 3600;

export interface Article {
  id: string;
  slug: string;
  status: string;
  current_version_id: string | null;
  published_version_id: string | null;
  first_published_at: string | null;
  created_by: number;
}
export interface Version {
  id: string;
  article_id: string;
  version_no: number;
  title_zh: string;
  body_zh: string;
  zh_hash: string;
  title_en: string | null;
  body_en: string | null;
  en_hash: string | null;
  en_source: string | null;
  translation_status: string;
  translation_error: string | null;
  qc_json: string | null;
}

export class Service {
  tg: Telegram;
  constructor(public env: Env, public fetcher: typeof fetch = ((i: any, o?: any) => fetch(i, o)) as typeof fetch) {
    this.tg = new Telegram(env.TELEGRAM_BOT_TOKEN, fetcher);
  }

  // ---------- data access ----------
  get auto(): boolean {
    return this.env.AUTO_PUBLISH === "true";
  }
  /** Progress chatter; silent in auto mode. */
  private async say(chatId: number, text: string) {
    if (!this.auto) await this.tg.send(chatId, text);
  }
  private async titleOf(articleId: string): Promise<string> {
    const r = await this.db().prepare("SELECT v.title_zh t FROM articles a JOIN versions v ON v.id=a.current_version_id WHERE a.id=?").bind(articleId).first<any>();
    return r?.t ?? articleId;
  }
  /** The one short failure note the user sees in auto mode. */
  private async failNote(chatId: number, articleId: string, what: string) {
    const lines = enabledPlatforms(this.env).map((p) => `${PLATFORM_LABEL[p] ?? p}：未成功`).join("\n");
    await this.tg.sendHtml(chatId, `❌ 《${esc(await this.titleOf(articleId))}》未发布\n${lines}\n<i>${esc(what.slice(0, 200))}</i>`);
  }

  /** Auto mode: one receipt per approval, once every platform job has finished. */
  async maybeReceipt(approvalId: string) {
    if (!this.auto) return;
    const jobs = (await this.db().prepare("SELECT * FROM publish_jobs WHERE approval_id=?").bind(approvalId).all<any>()).results ?? [];
    if (!jobs.length || jobs.some((j) => j.status === "active")) return;
    const ins = await this.db()
      .prepare("INSERT INTO publish_events (job_id, stage, ok, detail, at) SELECT ?, 'receipt', 1, '', ? WHERE NOT EXISTS (SELECT 1 FROM publish_events WHERE job_id=? AND stage='receipt')")
      .bind(approvalId, nowIso(), approvalId)
      .run();
    if (!ins.meta.changes) return;
    const a = (await this.article(jobs[0].article_id))!;
    const ap = await this.db().prepare("SELECT version_id FROM approvals WHERE id=?").bind(approvalId).first<any>();
    const v = (await this.version(ap.version_id))!;
    jobs.sort((x, y) => PLATFORM_ORDER.indexOf(x.platform) - PLATFORM_ORDER.indexOf(y.platform));
    const ok = jobs.filter((j) => j.status === "done").length;
    const head = ok === jobs.length ? "✅" : ok ? "⚠️" : "❌";
    const lines = jobs.map((j) => {
      const label = PLATFORM_LABEL[j.platform] ?? j.platform;
      if (j.status !== "done") return `${label}：未成功`;
      const urls: string[] = JSON.parse(j.public_urls || "[]");
      if (j.platform === "blog") return `${label}：<a href="${esc(urls[0])}">中文</a> · <a href="${esc(urls[1])}">English</a>`;
      return `${label}：<a href="${esc(urls[0])}">${esc(urls[0].replace(/^https?:\/\//, ""))}</a>`;
    });
    await this.tg.sendHtml(a.created_by, `${head} 《${esc(v.title_zh)}》${ok === jobs.length ? "已发布" : ok ? "部分发布" : "未发布"}\n${lines.join("\n")}`);
  }

  /** Cross-post to a non-blog platform once the blog itself is live (its URL is the canonical link). */
  async advanceCross(job: any) {
    const blog = await this.db().prepare("SELECT * FROM publish_jobs WHERE approval_id=? AND platform='blog'").bind(job.approval_id).first<any>();
    if (!blog || blog.status === "failed" || blog.status === "cancelled") {
      await this.db().prepare("UPDATE publish_jobs SET status='failed', last_error=?, updated_at=? WHERE id=?").bind("博客未发布，跳过", nowIso(), job.id).run();
      return this.maybeReceipt(job.approval_id);
    }
    if (blog.status !== "done") return this.wait(job, 20, "waiting for blog");
    const ap = await this.db().prepare("SELECT * FROM approvals WHERE id=?").bind(job.approval_id).first<any>();
    const v = (await this.version(ap.version_id))!;
    if (v.zh_hash !== ap.zh_hash || v.en_hash !== ap.en_hash) throw new Error("版本内容与审批不一致，拒绝发布");
    const [zhUrl, enUrl] = JSON.parse(blog.public_urls);
    const url = await postTo(job.platform, this.env, { articleId: job.article_id, titleZh: v.title_zh, bodyZh: v.body_zh, titleEn: v.title_en!, bodyEn: v.body_en!, zhUrl, enUrl }, this.fetcher);
    await this.event(job.id, `${job.platform}_post`, true, { url });
    await this.db().prepare("UPDATE publish_jobs SET stage='verified', status='done', public_urls=?, last_error=NULL, updated_at=? WHERE id=?").bind(JSON.stringify([url]), nowIso(), job.id).run();
    await this.maybeReceipt(job.approval_id);
  }

  db() {
    return this.env.DB;
  }
  async article(id: string): Promise<Article | null> {
    return this.db().prepare("SELECT * FROM articles WHERE id=?").bind(id).first<Article>();
  }
  async version(id: string): Promise<Version | null> {
    return this.db().prepare("SELECT * FROM versions WHERE id=?").bind(id).first<Version>();
  }
  async glossary(): Promise<Array<{ term_zh: string; term_en: string }>> {
    const r = await this.db().prepare("SELECT term_zh, term_en FROM glossary").all<{ term_zh: string; term_en: string }>();
    return r.results ?? [];
  }
  async glossaryHash(): Promise<string> {
    const g = (await this.glossary()).sort((a, b) => a.term_zh.localeCompare(b.term_zh));
    return sha256Hex(JSON.stringify(g));
  }

  // ---------- drafts & versions ----------
  async createArticle(userId: number, chatId: number, titleZh: string, bodyZh: string): Promise<string> {
    const now = nowIso();
    const id = randomId("a");
    const zhHash = await sha256Hex(zhHashInput(titleZh, bodyZh));
    const slug = makeSlug(null, zhHash);
    await this.db()
      .prepare("INSERT INTO articles (id, slug, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)")
      .bind(id, slug, "draft", userId, now, now)
      .run();
    const vid = await this.insertVersion(id, titleZh, normalizeBody(bodyZh), zhHash, null);
    await this.say(chatId, `中文原稿已保存 ✅\n编号：${id}\n版本：v1（${zhHash.slice(0, 8)}）\n正在翻译英文…`);
    await this.translateAndReview(vid, chatId);
    return id;
  }

  private async insertVersion(articleId: string, titleZh: string, bodyZh: string, zhHash: string, en: { title: string; body: string; source: string } | null): Promise<string> {
    const now = nowIso();
    const vid = randomId("v");
    const last = await this.db().prepare("SELECT COALESCE(MAX(version_no),0) AS n FROM versions WHERE article_id=?").bind(articleId).first<{ n: number }>();
    const no = (last?.n ?? 0) + 1;
    const enHash = en ? await sha256Hex(zhHashInput(en.title, en.body)) : null;
    await this.db().batch([
      this.db()
        .prepare(
          "INSERT INTO versions (id, article_id, version_no, title_zh, body_zh, zh_hash, title_en, body_en, en_hash, en_source, translation_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(vid, articleId, no, titleZh, bodyZh, zhHash, en?.title ?? null, en?.body ?? null, enHash, en?.source ?? null, en ? "done" : "pending", now),
      this.db().prepare("UPDATE articles SET current_version_id=?, status=?, updated_at=? WHERE id=?").bind(vid, en ? "in_review" : "draft", now, articleId),
    ]);
    await this.invalidateApprovals(articleId, `new version v${no}`);
    return vid;
  }

  /** Any edit invalidates approvals whose publishing has not committed anything yet. */
  async invalidateApprovals(articleId: string, reason: string) {
    const now = nowIso();
    await this.db().batch([
      this.db()
        .prepare("UPDATE publish_jobs SET status='cancelled', last_error=?, updated_at=? WHERE article_id=? AND status IN ('active','failed') AND stage='queued'")
        .bind(`cancelled: ${reason}`, now, articleId),
      this.db()
        .prepare(
          "UPDATE approvals SET invalidated_at=?, invalidated_reason=? WHERE article_id=? AND invalidated_at IS NULL AND id NOT IN (SELECT approval_id FROM publish_jobs WHERE article_id=? AND status IN ('active','done','failed') AND stage!='queued')",
        )
        .bind(now, reason, articleId, articleId),
    ]);
  }

  async editZh(articleId: string, chatId: number, titleZh: string, bodyZh: string) {
    const a = await this.article(articleId);
    if (!a) return this.tg.send(chatId, "找不到这篇文章");
    const zhHash = await sha256Hex(zhHashInput(titleZh, bodyZh));
    const cur = a.current_version_id ? await this.version(a.current_version_id) : null;
    if (cur && cur.zh_hash === zhHash) return this.tg.send(chatId, "中文内容没有变化，未创建新版本");
    const vid = await this.insertVersion(articleId, titleZh, normalizeBody(bodyZh), zhHash, null);
    await this.tg.send(chatId, `已保存中文修改，之前的审批已失效。正在重新翻译…`);
    await this.translateAndReview(vid, chatId);
  }

  async editEn(articleId: string, chatId: number, titleEn: string, bodyEn: string) {
    const a = await this.article(articleId);
    const cur = a?.current_version_id ? await this.version(a.current_version_id) : null;
    if (!a || !cur) return this.tg.send(chatId, "找不到这篇文章");
    const vid = await this.insertVersion(articleId, cur.title_zh, cur.body_zh, cur.zh_hash, { title: titleEn.trim(), body: normalizeBody(bodyEn), source: "user_edit" });
    const v = (await this.version(vid))!;
    const qc = runQc(v.title_zh, v.body_zh, v.title_en!, v.body_en!, await this.glossary());
    await this.db().prepare("UPDATE versions SET qc_json=? WHERE id=?").bind(JSON.stringify(qc), vid).run();
    await this.tg.send(chatId, "已保存你修改的英文译稿，之前的审批已失效。");
    await this.sendReview(vid, chatId);
  }

  // ---------- translation ----------
  async translateAndReview(versionId: string, chatId: number) {
    const v = await this.version(versionId);
    if (!v) return;
    await this.db().prepare("UPDATE articles SET status='translating', updated_at=? WHERE id=?").bind(nowIso(), v.article_id).run();
    const glossary = await this.glossary();
    const cacheKey = await sha256Hex(`${v.zh_hash}|${await this.glossaryHash()}|${ENGINE}`);
    try {
      let title: string, body: string, source: string;
      const cached = await this.db().prepare("SELECT * FROM translation_cache WHERE cache_key=?").bind(cacheKey).first<any>();
      if (cached) {
        ({ title_en: title, body_en: body } = cached);
        source = "cache";
      } else {
        const r = await translateZhToEn(this.env.DEEPL_API_KEY, v.title_zh, v.body_zh, {
          minRemaining: Number(this.env.DEEPL_MIN_REMAINING || "2000"),
          glossary,
          fetcher: this.fetcher,
        });
        title = r.title;
        body = r.body;
        source = "deepl";
        const billed = r.actualChars ?? r.chars;
        await this.db().batch([
          this.db()
            .prepare("INSERT OR IGNORE INTO translation_cache (cache_key, title_en, body_en, engine, chars_billed, created_at) VALUES (?,?,?,?,?,?)")
            .bind(cacheKey, title, body, ENGINE, billed, nowIso()),
          this.db()
            .prepare("INSERT INTO usage_log (provider, chars, article_id, detail, at) VALUES ('deepl',?,?,?,?)")
            .bind(billed, v.article_id, JSON.stringify({ estimate: r.chars, actual: r.actualChars, after: r.usageAfter ? { count: r.usageAfter.character_count, limit: r.usageAfter.character_limit } : null }), nowIso()),
        ]);
      }
      const enHash = await sha256Hex(zhHashInput(title, body));
      const qc = runQc(v.title_zh, v.body_zh, title, body, glossary);
      await this.db().batch([
        this.db()
          .prepare("UPDATE versions SET title_en=?, body_en=?, en_hash=?, en_source=?, translation_status='done', translation_error=NULL, qc_json=? WHERE id=?")
          .bind(title, body, enHash, source, JSON.stringify(qc), versionId),
        this.db().prepare("UPDATE articles SET status='in_review', updated_at=? WHERE id=?").bind(nowIso(), v.article_id),
      ]);
      await this.maybeRefreshSlug(v.article_id, title, v.zh_hash);
      if (this.auto) {
        if (await this.autoApprove(versionId, chatId)) await this.processDueJobs();
      } else await this.sendReview(versionId, chatId);
    } catch (e: any) {
      const paused = e instanceof QuotaError || e instanceof KeyTypeError;
      await this.db().batch([
        this.db()
          .prepare("UPDATE versions SET translation_status=?, translation_error=? WHERE id=?")
          .bind(paused ? "paused_quota" : "failed", String(e?.message ?? e), versionId),
        this.db().prepare("UPDATE articles SET status=?, updated_at=? WHERE id=?").bind(paused ? "translation_paused" : "translation_failed", nowIso(), v.article_id),
      ]);
      if (this.auto) return this.failNote(chatId, v.article_id, `翻译${paused ? "额度不足" : "失败"}：${e?.message ?? e}`);
      await this.tg.send(
        chatId,
        `${paused ? "⏸ 翻译已暂停" : "⚠️ 翻译失败"}：${e?.message ?? e}\n中文原稿已安全保存（${v.article_id}）。\n` +
          `处理后发送 /retranslate ${v.article_id}，或用 /en ${v.article_id} 自己提供英文。`,
      );
    }
  }

  /** Before first publication, derive a readable slug from the English title. */
  async maybeRefreshSlug(articleId: string, titleEn: string, zhHash: string) {
    const a = await this.article(articleId);
    if (!a || a.first_published_at) return;
    let slug = makeSlug(titleEn, zhHash);
    const clash = await this.db().prepare("SELECT id FROM articles WHERE slug=? AND id!=?").bind(slug, articleId).first();
    if (clash) slug = `${slug}-${zhHash.slice(0, 6)}`;
    await this.db().prepare("UPDATE articles SET slug=? WHERE id=?").bind(slug, articleId).run();
  }

  // ---------- review ----------
  async previewUrl(versionId: string): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_S;
    const sig = await hmacHex(this.env.PREVIEW_SIGNING_KEY, `${versionId}.${exp}`);
    return `${this.env.WORKER_URL.replace(/\/$/, "")}/preview/${versionId}?exp=${exp}&sig=${sig}`;
  }

  async sendReview(versionId: string, chatId: number) {
    const v = (await this.version(versionId))!;
    const a = (await this.article(v.article_id))!;
    const platforms = canonicalPlatforms(enabledPlatforms(this.env));
    const hash = await approvalHash(v.id, v.zh_hash, v.en_hash!, platforms);
    const qc = v.qc_json ? JSON.parse(v.qc_json) : null;
    const qcLine = qc ? (qc.issues.length ? `翻译检查：${qc.issues.length} 项提示\n- ${qc.issues.map((i: any) => i.detail).join("\n- ")}` : "翻译检查：未发现问题") : "";
    const text =
      `📝 待审核 ${a.id} v${v.version_no}\n` +
      `中文：${v.title_zh}\n英文：${v.title_en}\n` +
      `中文哈希 ${v.zh_hash.slice(0, 12)} · 英文哈希 ${v.en_hash!.slice(0, 12)}（${v.en_source}）\n` +
      `发布平台：${platforms.join(", ")}${this.env.PUBLISH_MODE === "production" ? "" : "（测试模式：预览分支，不进生产）"}\n` +
      `地址：/zh/posts/${a.slug}/ ・ /en/posts/${a.slug}/\n\n${qcLine}\n\n` +
      `双语预览（受保护，7 天有效）：\n${await this.previewUrl(v.id)}\n\n` +
      `修改中文：/edit ${a.id}\n修改英文：/en ${a.id}`;
    await this.tg.send(chatId, text, {
      reply_markup: kb([
        [{ text: `✅ 批准发布到 ${platforms.join("+")}`, data: `ap:${v.id}:${hash.slice(0, 16)}` }],
        [
          { text: "🔁 重新翻译", data: `rt:${a.id}` },
          { text: "🗑 放弃", data: `dc:${a.id}` },
        ],
      ]),
    });
  }

  /** Auto mode: the user's own message is the approval (asked for 2026-11-04). */
  async autoApprove(versionId: string, chatId: number): Promise<boolean> {
    const v = await this.version(versionId);
    const a = v ? await this.article(v.article_id) : null;
    if (!v || !a || !v.en_hash) return false;
    const h = await approvalHash(v.id, v.zh_hash, v.en_hash, canonicalPlatforms(enabledPlatforms(this.env)));
    const res = await this.approve(Number(a.created_by), chatId, v.id, h.slice(0, 16));
    if (res !== "已批准") {
      await this.failNote(chatId, a.id, res);
      return false;
    }
    return true;
  }

  // ---------- approval ----------
  async approve(userId: number, chatId: number, versionId: string, hashPrefix: string): Promise<string> {
    const v = await this.version(versionId);
    const a = v ? await this.article(v.article_id) : null;
    if (!v || !a) return "版本不存在";

    // Idempotent: a repeated click on an already-accepted approval returns its status.
    const platforms = canonicalPlatforms(enabledPlatforms(this.env));
    if (v.en_hash) {
      const h = await approvalHash(v.id, v.zh_hash, v.en_hash, platforms);
      const existing = await this.db().prepare("SELECT id FROM approvals WHERE approval_hash=?").bind(h).first();
      if (existing && h.startsWith(hashPrefix)) return "这个版本已经批准过，正在发布或已发布，不会重复发布";
    }

    const res = await checkApproval({
      requested: { versionId, hashPrefix },
      article: a,
      version: v,
      platforms,
      allowedPlatforms: enabledPlatforms(this.env),
    });
    if (!res.ok) return res.reason;

    const now = nowIso();
    const apId = randomId("ap");
    const stmts = [
      this.db()
        .prepare("INSERT OR IGNORE INTO approvals (id, article_id, version_id, zh_hash, en_hash, platforms, approval_hash, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(apId, a.id, v.id, v.zh_hash, v.en_hash, JSON.stringify(platforms), res.hash, userId, now),
      this.db().prepare("UPDATE articles SET status='publishing', updated_at=? WHERE id=? AND status='in_review'").bind(now, a.id),
    ];
    for (const p of platforms) {
      stmts.push(
        this.db()
          .prepare(
            "INSERT OR IGNORE INTO publish_jobs (id, idempotency_key, article_id, approval_id, platform, stage, status, attempts, next_attempt_at, created_at, updated_at) VALUES (?,?,?,(SELECT id FROM approvals WHERE approval_hash=?),?,'queued','active',0,?,?,?)",
          )
          .bind(randomId("job"), idempotencyKey(a.id, p, res.hash), a.id, res.hash, p, now, now, now),
      );
    }
    await this.db().batch(stmts);
    await this.say(chatId, `已批准 ${a.id} v${v.version_no}（审批哈希 ${res.hash.slice(0, 12)}）。开始发布，完成验证后会把链接发给你。`);
    return "已批准";
  }

  // ---------- publishing state machine ----------
  async processDueJobs(limit = 5) {
    const now = nowIso();
    const r = await this.db()
      .prepare("SELECT * FROM publish_jobs WHERE status='active' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT ?")
      .bind(now, limit)
      .all<any>();
    for (const job of r.results ?? []) {
      try {
        await this.advanceJob(job);
      } catch (e: any) {
        await this.jobError(job, String(e?.message ?? e));
      }
    }
  }

  private async event(jobId: string, stage: string, ok: boolean, detail: unknown) {
    await this.db().prepare("INSERT INTO publish_events (job_id, stage, ok, detail, at) VALUES (?,?,?,?,?)").bind(jobId, stage, ok ? 1 : 0, typeof detail === "string" ? detail : JSON.stringify(detail), nowIso()).run();
  }

  private async jobError(job: any, msg: string) {
    const attempts = job.attempts + 1;
    const failed = attempts >= MAX_JOB_ATTEMPTS;
    await this.db()
      .prepare("UPDATE publish_jobs SET attempts=?, last_error=?, status=?, next_attempt_at=?, updated_at=? WHERE id=?")
      .bind(attempts, msg, failed ? "failed" : "active", addSeconds(nowIso(), backoffSeconds(attempts)), nowIso(), job.id)
      .run();
    await this.event(job.id, failed ? "error" : "retry", false, { attempts, msg });
    if (failed) {
      await this.db().prepare("UPDATE articles SET status='publish_failed', updated_at=? WHERE id=?").bind(nowIso(), job.article_id).run();
      const a = await this.article(job.article_id);
      if (a && this.auto) {
        if (job.platform === "blog") await this.db().prepare("UPDATE publish_jobs SET status='failed', last_error='博客未发布，跳过', updated_at=? WHERE approval_id=? AND status='active'").bind(nowIso(), job.approval_id).run();
        await this.maybeReceipt(job.approval_id);
      }
      else if (a) await this.tg.send(a.created_by, `❌ 发布失败（${job.platform}，阶段 ${job.stage} 之后）：${msg}\n原稿和已完成的步骤都已保存。发送 /retry ${job.article_id} 从断点继续。`);
    }
  }

  private async wait(job: any, seconds: number, note: string) {
    await this.db().prepare("UPDATE publish_jobs SET next_attempt_at=?, last_error=?, updated_at=? WHERE id=?").bind(addSeconds(nowIso(), seconds), note, nowIso(), job.id).run();
  }

  async advanceJob(job: any) {
    if (job.platform !== "blog") return this.advanceCross(job);
    const ap = await this.db().prepare("SELECT * FROM approvals WHERE id=?").bind(job.approval_id).first<any>();
    const v = ap ? await this.version(ap.version_id) : null;
    const a = await this.article(job.article_id);
    if (!ap || !v || !a) throw new Error("审批或版本记录缺失");
    // Defence in depth: the approved hashes must still match the stored version.
    if (v.zh_hash !== ap.zh_hash || v.en_hash !== ap.en_hash) throw new Error("版本内容与审批不一致，拒绝发布");
    if (ap.invalidated_at && job.stage === "queued") {
      await this.db().prepare("UPDATE publish_jobs SET status='cancelled', updated_at=? WHERE id=?").bind(nowIso(), job.id).run();
      return;
    }

    const gh = new GitHub(this.env.GITHUB_TOKEN, this.env.GITHUB_REPO, this.fetcher);
    const branch = this.env.GITHUB_BRANCH;
    const env = this.env.PUBLISH_MODE === "production" ? "production" : "preview";

    if (job.stage === "queued") {
      const date = a.first_published_at ?? nowIso();
      const files = [
        { path: postPath("zh", a.slug), content: renderPostFile({ slug: a.slug, lang: "zh", title: v.title_zh, body: v.body_zh, date, updated: a.first_published_at ? nowIso() : undefined, articleId: a.id, versionId: v.id, versionHash: v.zh_hash, approvalHash: ap.approval_hash }) },
        { path: postPath("en", a.slug), content: renderPostFile({ slug: a.slug, lang: "en", title: v.title_en!, body: v.body_en!, date, updated: a.first_published_at ? nowIso() : undefined, articleId: a.id, versionId: v.id, versionHash: v.en_hash!, approvalHash: ap.approval_hash, translationOf: v.zh_hash }) },
      ];
      // Idempotency: if both files already carry this approval hash, a previous attempt committed them.
      const [zhNow, enNow] = await Promise.all(files.map((f) => gh.getFileText(f.path, branch)));
      const marker = `approvalHash: "${ap.approval_hash}"`;
      let sha: string;
      if (zhNow?.includes(marker) && enNow?.includes(marker)) {
        sha = (await gh.latestCommitForPath(files[0].path, branch))!;
        await this.event(job.id, "github_commit", true, { sha, reused: true });
      } else {
        sha = await gh.commitFiles(branch, files, `publish: ${a.slug} (${a.id} v${v.version_no}, approval ${ap.approval_hash.slice(0, 12)})`);
        await this.event(job.id, "github_commit", true, { sha, branch });
      }
      await this.db()
        .prepare("UPDATE publish_jobs SET stage='committed', commit_sha=?, attempts=0, last_error=NULL, next_attempt_at=?, updated_at=? WHERE id=?")
        .bind(sha, addSeconds(nowIso(), 45), nowIso(), job.id)
        .run();
      if (!a.first_published_at) await this.db().prepare("UPDATE articles SET first_published_at=? WHERE id=?").bind(date, a.id).run();
      await this.say(a.created_by, `① GitHub 提交成功：${sha.slice(0, 7)}（${branch}）。等待 Cloudflare Pages 构建…`);
      return;
    }

    if (job.stage === "committed") {
      const d = await findDeployment({ token: this.env.CF_API_TOKEN, accountId: this.env.CF_ACCOUNT_ID, project: this.env.PAGES_PROJECT, commitSha: job.commit_sha, env }, this.fetcher);
      if (d.state === "not_found" || d.state === "building") {
        const ev = await this.db().prepare("SELECT at FROM publish_events WHERE job_id=? AND stage='github_commit' AND ok=1 ORDER BY id DESC LIMIT 1").bind(job.id).first<{ at: string }>();
        const ageMin = (Date.now() - new Date(ev?.at ?? job.updated_at).getTime()) / 60000;
        if (ageMin > 30) throw new Error(`Pages 部署 30 分钟未完成（${d.state === "building" ? d.stage : "未找到该提交的部署"}）`);
        return this.wait(job, 30, `pages: ${d.state}${d.state === "building" ? " " + d.stage : ""}`);
      }
      if (d.state === "failed") {
        await this.event(job.id, "pages_deploy", false, d);
        if (job.attempts < 2) await retryDeployment({ token: this.env.CF_API_TOKEN, accountId: this.env.CF_ACCOUNT_ID, project: this.env.PAGES_PROJECT, deploymentId: d.id }, this.fetcher);
        throw new Error(`Pages 部署失败：${d.stage}`);
      }
      const base = env === "production" ? this.env.SITE_URL : d.aliases[0] ?? d.url;
      await this.event(job.id, "pages_deploy", true, { id: d.id, url: d.url, aliases: d.aliases });
      await this.db()
        .prepare("UPDATE publish_jobs SET stage='deployed', deployment_id=?, deployment_url=?, attempts=0, last_error=NULL, next_attempt_at=?, updated_at=? WHERE id=?")
        .bind(d.id, base, nowIso(), nowIso(), job.id)
        .run();
      await this.say(a.created_by, `② Pages 部署成功：${d.url}\n正在验证公开页面…`);
      return;
    }

    if (job.stage === "deployed") {
      const urls = [publicPostUrl(job.deployment_url, "zh", a.slug), publicPostUrl(job.deployment_url, "en", a.slug)];
      const checks = await Promise.all([verifyPublicUrl(urls[0], v.zh_hash, this.fetcher), verifyPublicUrl(urls[1], v.en_hash!, this.fetcher)]);
      await this.event(job.id, "url_verify", checks.every((c) => c.ok), { urls, checks });
      if (!checks.every((c) => c.ok)) throw new Error(`公开页面验证未通过：${checks.map((c, i) => `${urls[i]} → ${c.detail}`).join("; ")}`);
      await this.db().batch([
        this.db().prepare("UPDATE publish_jobs SET stage='verified', status='done', public_urls=?, last_error=NULL, updated_at=? WHERE id=?").bind(JSON.stringify(urls), nowIso(), job.id),
        this.db()
          .prepare("UPDATE articles SET status=CASE WHEN current_version_id=? THEN 'published' ELSE status END, published_version_id=?, updated_at=? WHERE id=?")
          .bind(v.id, v.id, nowIso(), a.id),
      ]);
      if (this.auto) return this.maybeReceipt(job.approval_id);
      await this.tg.send(a.created_by, `③ 公开页面验证成功 ✅（${env === "production" ? "生产" : "预览环境"}）\n中文：${urls[0]}\n英文：${urls[1]}`);
    }
  }

  async retry(articleId: string): Promise<string> {
    const r = await this.db()
      .prepare("UPDATE publish_jobs SET status='active', attempts=0, next_attempt_at=?, updated_at=? WHERE article_id=? AND status='failed'")
      .bind(nowIso(), nowIso(), articleId)
      .run();
    if (!r.meta.changes) return "没有可重试的失败任务";
    await this.db().prepare("UPDATE articles SET status='publishing', updated_at=? WHERE id=?").bind(nowIso(), articleId).run();
    return "已从断点重新开始发布";
  }

  async status(articleId: string): Promise<string> {
    const a = await this.article(articleId);
    if (!a) return "找不到这篇文章";
    const v = a.current_version_id ? await this.version(a.current_version_id) : null;
    const jobs = await this.db().prepare("SELECT platform, stage, status, attempts, commit_sha, public_urls, last_error FROM publish_jobs WHERE article_id=? ORDER BY created_at DESC LIMIT 3").bind(articleId).all<any>();
    const jl = (jobs.results ?? [])
      .map((j) => `· ${j.platform}: ${j.stage}/${j.status}${j.commit_sha ? ` commit ${j.commit_sha.slice(0, 7)}` : ""}${j.public_urls ? `\n  ${JSON.parse(j.public_urls).join("\n  ")}` : ""}${j.last_error && j.status !== "done" ? `\n  错误：${j.last_error}` : ""}`)
      .join("\n");
    return `${a.id}\n状态：${a.status}\nslug：${a.slug}\n当前版本：v${v?.version_no ?? "?"}（翻译 ${v?.translation_status ?? "?"}）\n${jl || "暂无发布任务"}`;
  }

  async quota(): Promise<string> {
    const u = await deeplUsage(this.env.DEEPL_API_KEY, this.fetcher);
    const used = await this.db().prepare("SELECT COALESCE(SUM(chars),0) AS n FROM usage_log WHERE provider='deepl'").first<{ n: number }>();
    return `DeepL（免费 :fx 密钥）：已用 ${u.character_count.toLocaleString()} / ${u.character_limit.toLocaleString()} 字符，剩余 ${(u.character_limit - u.character_count).toLocaleString()}\n本系统累计记录消耗：${used?.n ?? 0} 字符\n注意：新开通的 Developer 方案是一次性额度，用完不会重置。额度不足时自动暂停翻译，不会切换付费。`;
  }

  async discard(articleId: string): Promise<string> {
    const a = await this.article(articleId);
    if (!a) return "找不到这篇文章";
    if (a.first_published_at) return "这篇已经发布过，P0 不支持在 Bot 里下线（需人工处理），未做改动";
    await this.invalidateApprovals(articleId, "discarded");
    await this.db().prepare("UPDATE articles SET status='discarded', updated_at=? WHERE id=?").bind(nowIso(), articleId).run();
    return "已放弃（原稿仍保留在数据库中）";
  }
}
