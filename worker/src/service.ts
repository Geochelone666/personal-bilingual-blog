import { Env } from "./env";
import { enabledPlatforms, postTo, PLATFORM_LABEL, PLATFORM_ORDER } from "./platforms";
import { sha256Hex, nowIso, randomId, zhHashInput, normalizeBody, makeSlug, backoffSeconds, addSeconds, hmacHex } from "./util";
import { fixSentenceSpacing } from "./util";
import { translateZhToEn, QuotaError, KeyTypeError, deeplUsage } from "./deepl";
import { runQc } from "./qc";
import { approvalHash, checkApproval, canonicalPlatforms, idempotencyKey } from "./approval";
import { Telegram, kb, esc } from "./telegram";
import { GitHub } from "./github";
import { findDeployment, retryDeployment, verifyPublicUrl } from "./pages";
import { renderPostFile, postPath, publicPostUrl } from "./render";
import { Kind, Category, classify, recommend, defaultTargets, buildDrafts, draftHash, platformDraftHash, LABEL, CATEGORY_LABEL, Rec, Drafts } from "./p4";
import { publishTelegram, publishBluesky, publishDevto, AuthError } from "./publishers";

const ENGINE = "deepl-free-v2";
const LEASE_MS = 90_000;
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
  kind?: Kind;
  category?: Category | null;
  targets?: string | null;
  cover_file_id?: string | null;
  cover_sha?: string | null;
  review_sent_for?: string | null;
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
  private async say(chatId: number, text: string) {
    await this.tg.send(chatId, text);
  }
  private async titleOf(articleId: string): Promise<string> {
    const r = await this.db().prepare("SELECT v.title_zh t FROM articles a JOIN versions v ON v.id=a.current_version_id WHERE a.id=?").bind(articleId).first<any>();
    return r?.t ?? articleId;
  }
  /** One receipt per approval, once every platform job has finished. */
  async maybeReceipt(approvalId: string) {
    const jobs = (await this.db().prepare("SELECT * FROM publish_jobs WHERE approval_id=?").bind(approvalId).all<any>()).results ?? [];
    if (!jobs.length || jobs.some((j) => j.status === "active" && j.stage !== "external")) return;
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
      if (j.stage === "external" && j.status === "active") return `${label}：排队中（浏览器导入，通常 1 小时内）`;
      if (j.status !== "done") return `${label}：未成功${j.last_error ? `（${esc(String(j.last_error).slice(0, 80))}）` : ""}`;
      const urls: string[] = JSON.parse(j.public_urls || "[]");
      if (!urls.length) return `${label}：完成`;
      if (j.platform === "blog") return `${label}：<a href="${esc(urls[0])}">中文</a> · <a href="${esc(urls[1])}">English</a>`;
      return `${label}：<a href="${esc(urls[0])}">${esc(urls[0].replace(/^https?:\/\//, ""))}</a>`;
    });
    const failed = jobs.some((j) => j.status === "failed");
    await this.tg.sendHtml(a.created_by, `${head} 《${esc(v.title_zh)}》${ok === jobs.length ? "已发布" : ok ? "部分发布" : "未发布"}\n${lines.join("\n")}${failed ? `\n重试失败的平台：/retry ${a.id}` : ""}`);
  }

  /** Cross-post exactly the approved draft. Platforms that link to the blog wait until the blog job is verified. */
  async advanceCross(job: any) {
    const ap = await this.db().prepare("SELECT * FROM approvals WHERE id=?").bind(job.approval_id).first<any>();
    const v = ap ? await this.version(ap.version_id) : null;
    if (!ap || !v) throw new Error("审批或版本记录缺失");
    if (v.zh_hash !== ap.zh_hash || v.en_hash !== ap.en_hash) throw new Error("版本内容与审批不一致，拒绝发布");
    if (ap.invalidated_at && job.stage === "queued" && !job.deployment_id) {
      await this.db().prepare("UPDATE publish_jobs SET status='cancelled', last_error='审批已失效', updated_at=? WHERE id=?").bind(nowIso(), job.id).run();
      return this.maybeReceipt(job.approval_id);
    }
    const blog = await this.db().prepare("SELECT * FROM publish_jobs WHERE approval_id=? AND platform='blog'").bind(job.approval_id).first<any>();
    if (blog) {
      if (blog.status === "failed" || blog.status === "cancelled") {
        await this.db().prepare("UPDATE publish_jobs SET status='failed', last_error=?, updated_at=? WHERE id=?").bind("博客未发布，跳过", nowIso(), job.id).run();
        return this.maybeReceipt(job.approval_id);
      }
      if (blog.status !== "done") return this.wait(job, 20, "waiting for blog");
    }
    const drafts: Drafts | null = ap.drafts_json ? JSON.parse(ap.drafts_json) : null;
    if (!drafts) return this.legacyCross(job, ap, v, blog);
    const draft = drafts[job.platform];
    if (!draft) throw new Error(`审批中没有 ${job.platform} 的草稿`);
    const contentHash = await platformDraftHash(drafts, job.platform);

    if (job.platform === "medium") {
      // No Medium API: Hark's scheduled browser task imports the blog URL and marks this job done.
      await this.db().prepare("UPDATE publish_jobs SET stage='external', content_hash=?, next_attempt_at='9999-12-31T00:00:00Z', last_error='等待浏览器导入 Medium', updated_at=? WHERE id=?").bind(contentHash, nowIso(), job.id).run();
      await this.event(job.id, "medium_queued", true, { source: draft.source });
      return this.maybeReceipt(job.approval_id);
    }

    const prev = await this.db()
      .prepare("SELECT remote_id, public_urls, content_hash FROM publish_jobs WHERE article_id=? AND platform=? AND status='done' AND id!=? ORDER BY updated_at DESC LIMIT 1")
      .bind(job.article_id, job.platform, job.id)
      .first<any>();
    const ctx = {
      jobId: job.id,
      createdAt: job.created_at,
      state: job.deployment_id ? JSON.parse(job.deployment_id) : null,
      save: async (st: any) => { await this.db().prepare("UPDATE publish_jobs SET deployment_id=?, updated_at=? WHERE id=?").bind(JSON.stringify(st), nowIso(), job.id).run(); },
      previous: prev ? { remote: prev.remote_id ? JSON.parse(prev.remote_id) : null, urls: JSON.parse(prev.public_urls || "[]"), contentHash: prev.content_hash } : null,
      contentHash,
    };
    let res;
    if (job.platform === "telegram" || job.platform === "telegram_en") res = await publishTelegram(this.env, job.platform, draft, ctx, this.fetcher);
    else if (job.platform === "bluesky") res = await publishBluesky(this.env, draft, ctx, this.fetcher, this.env.SITE_URL);
    else if (job.platform === "devto") res = await publishDevto(this.env, draft, ctx, this.fetcher);
    else throw new Error(`未知平台 ${job.platform}`);
    await this.event(job.id, `${job.platform}_post`, true, { url: res.url, note: res.note ?? null });
    await this.db()
      .prepare("UPDATE publish_jobs SET stage='verified', status='done', public_urls=?, remote_id=?, content_hash=?, last_error=?, updated_at=? WHERE id=?")
      .bind(JSON.stringify([res.url]), JSON.stringify(res.remote), contentHash, res.note ?? null, nowIso(), job.id)
      .run();
    await this.maybeQuickDone(job.approval_id);
    await this.maybeReceipt(job.approval_id);
  }

  /** Quick thoughts have no blog job: mark the article published once its jobs finish. */
  private async maybeQuickDone(approvalId: string) {
    const jobs = (await this.db().prepare("SELECT platform, status FROM publish_jobs WHERE approval_id=?").bind(approvalId).all<any>()).results ?? [];
    if (jobs.some((j) => j.platform === "blog") || jobs.some((j) => j.status === "active")) return;
    const ap = await this.db().prepare("SELECT article_id, version_id FROM approvals WHERE id=?").bind(approvalId).first<any>();
    if (jobs.some((j) => j.status === "done"))
      await this.db().prepare("UPDATE articles SET status=CASE WHEN current_version_id=? THEN 'published' ELSE status END, published_version_id=?, first_published_at=COALESCE(first_published_at, ?), updated_at=? WHERE id=?").bind(ap.version_id, ap.version_id, nowIso(), nowIso(), ap.article_id).run();
  }

  /** P1 approvals (before drafts were bound) keep their original behaviour. */
  private async legacyCross(job: any, ap: any, v: Version, blog: any) {
    const [zhUrl, enUrl] = JSON.parse(blog.public_urls);
    const url = await postTo(job.platform, this.env, { articleId: job.article_id, titleZh: v.title_zh, bodyZh: v.body_zh, titleEn: v.title_en!, bodyEn: v.body_en!, zhUrl, enUrl }, this.fetcher, {
      state: job.deployment_id ?? null,
      save: async (st) => { await this.db().prepare("UPDATE publish_jobs SET deployment_id=?, updated_at=? WHERE id=?").bind(st, nowIso(), job.id).run(); },
    });
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
  async createArticle(userId: number, chatId: number, titleZh: string, bodyZh: string, kind: Kind = "article", sourceUpdate: number | null = null): Promise<string> {
    const now = nowIso();
    if (sourceUpdate != null) {
      // Replaying a Telegram update must never create a second article.
      const dup = await this.db().prepare("SELECT id, status, current_version_id FROM articles WHERE source_update=?").bind(sourceUpdate).first<any>();
      if (dup) {
        // Resume where the interrupted run stopped (it was saved, but translation never finished).
        if (dup.current_version_id && ["draft", "translation_failed"].includes(dup.status)) await this.translateAndReview(dup.current_version_id, chatId);
        return dup.id;
      }
    }
    const id = randomId("a");
    const zhHash = await sha256Hex(zhHashInput(titleZh, bodyZh));
    const slug = makeSlug(null, zhHash);
    const category = classify(titleZh, bodyZh).category;
    await this.db()
      .prepare("INSERT INTO articles (id, slug, status, created_by, created_at, updated_at, kind, category, source_update) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, slug, "draft", userId, now, now, kind, category, sourceUpdate)
      .run();
    const vid = await this.insertVersion(id, titleZh, normalizeBody(bodyZh), zhHash, null);
    // The Chinese original is saved before anything else can fail.
    await this.say(chatId, `中文原稿已保存 ✅（${kind === "quick" ? "短想法" : "文章"} ${id} v1）\n正在翻译英文…`);
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
    await this.db().prepare("UPDATE articles SET category=? WHERE id=?").bind(classify(titleZh, bodyZh).category, articleId).run();
    await this.tg.send(chatId, `已保存中文修改（新版本），之前的审批已失效。正在重新翻译…`);
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
        body = fixSentenceSpacing(r.body);
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
      if (this.env.PROOFREAD === "true") {
        // Hark proofreads the English, then flips the article back to in_review;
        // the cron sweep then sends the review card.
        await this.db().prepare("UPDATE articles SET status='awaiting_proofread', updated_at=? WHERE id=?").bind(nowIso(), v.article_id).run();
        await this.say(chatId, `英文已译好，校对后（最多约 30 分钟）把审核卡发给你。`);
      } else await this.sendReview(versionId, chatId);
    } catch (e: any) {
      const paused = e instanceof QuotaError || e instanceof KeyTypeError;
      await this.db().batch([
        this.db()
          .prepare("UPDATE versions SET translation_status=?, translation_error=? WHERE id=?")
          .bind(paused ? "paused_quota" : "failed", String(e?.message ?? e), versionId),
        this.db().prepare("UPDATE articles SET status=?, updated_at=? WHERE id=?").bind(paused ? "translation_paused" : "translation_failed", nowIso(), v.article_id),
      ]);
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

  // ---------- P4: targets, drafts, review card ----------
  recs(a: Article, v: Version): Rec[] {
    const c = classify(v.title_zh, v.body_zh);
    return recommend((a.kind ?? "article") as Kind, (a.category ?? c.category) as Category, enabledPlatforms(this.env), c.scores.dev, c.hasCode);
  }
  targetsOf(a: Article, v: Version): string[] {
    const recs = this.recs(a, v);
    const avail = recs.filter((r) => r.available).map((r) => r.platform);
    const chosen: string[] = a.targets ? JSON.parse(a.targets) : defaultTargets(recs);
    const t = chosen.filter((p) => avail.includes(p));
    if ((a.kind ?? "article") === "article" && !t.includes("blog")) t.unshift("blog");
    return canonicalPlatforms(t);
  }
  draftsFor(a: Article, v: Version, targets: string[]): Drafts {
    const kind = (a.kind ?? "article") as Kind;
    return buildDrafts(
      {
        kind,
        category: (a.category ?? "essay") as Category,
        titleZh: v.title_zh, bodyZh: v.body_zh, titleEn: v.title_en!, bodyEn: v.body_en!,
        zhUrl: kind === "article" ? publicPostUrl(this.env.SITE_URL, "zh", a.slug) : undefined,
        enUrl: kind === "article" ? publicPostUrl(this.env.SITE_URL, "en", a.slug) : undefined,
        cover: a.cover_sha ? { type: "custom", sha: a.cover_sha } : { type: "generated" },
      },
      targets,
    );
  }
  /** Everything the approve button binds, computed from the current state. */
  async reviewState(articleId: string) {
    const a = await this.article(articleId);
    const v = a?.current_version_id ? await this.version(a.current_version_id) : null;
    if (!a || !v || !v.en_hash) return null;
    const targets = this.targetsOf(a, v);
    const drafts = this.draftsFor(a, v, targets);
    const dh = await draftHash(drafts);
    const hash = await approvalHash(v.id, v.zh_hash, v.en_hash, targets, dh);
    return { a, v, targets, drafts, draftsHash: dh, hash };
  }

  async sendReview(versionId: string, chatId: number) {
    const v = (await this.version(versionId))!;
    const st = (await this.reviewState(v.article_id))!;
    if (!st || st.v.id !== v.id) return;
    const { a } = st;
    // Platform drafts that people will read in the channels / on Bluesky, shown in full.
    const parts: string[] = [];
    for (const p of st.targets) {
      const d = st.drafts[p];
      if (p === "telegram" || p === "telegram_en") parts.push(`【${LABEL[p]}】\n${d.messages.map(htmlToText).join("\n—\n")}`);
      if (p === "bluesky") parts.push(`【Bluesky ${d.posts.length > 1 ? `Thread ${d.posts.length} 条` : "单帖"}】\n${d.posts.map((x: string, i: number) => `${i + 1}) ${x}`).join("\n\n")}`);
    }
    if (a.kind === "quick") parts.unshift(`【中文原稿】\n${v.body_zh}`, `【英文译稿】\n${v.body_en}`);
    for (const chunk of chunkText(parts.join("\n\n"), 3800)) await this.tg.send(chatId, chunk);
    const card = await this.reviewCard(st);
    await this.tg.send(chatId, card.text, { reply_markup: card.markup });
    await this.db().prepare("UPDATE articles SET review_sent_for=? WHERE id=?").bind(`${v.id}|${st.hash.slice(0, 16)}`, a.id).run();
  }

  async reviewCard(st: NonNullable<Awaited<ReturnType<Service["reviewState"]>>>) {
    const { a, v, targets } = st;
    const recs = this.recs(a, v);
    const qc = v.qc_json ? JSON.parse(v.qc_json) : null;
    const prevHashes = new Map<string, string>();
    if (a.first_published_at) {
      const done = (await this.db().prepare("SELECT platform, content_hash FROM publish_jobs WHERE article_id=? AND status='done' ORDER BY updated_at").bind(a.id).all<any>()).results ?? [];
      for (const j of done) if (j.content_hash) prevHashes.set(j.platform, j.content_hash);
    }
    const lines: string[] = [];
    for (const r of recs) {
      const sel = targets.includes(r.platform);
      let sync = "";
      if (sel && prevHashes.has(r.platform)) sync = prevHashes.get(r.platform) === (await platformDraftHash(st.drafts, r.platform)) ? "（无变化）" : r.platform === "bluesky" ? "（已发过，Bluesky 不能编辑，不会重发）" : "（需同步更新）";
      lines.push(`${!r.available ? "—" : sel ? "✅" : "⬜"} ${LABEL[r.platform]}：${r.reason}${sync}`);
    }
    const cat = CATEGORY_LABEL[(a.category ?? "essay") as Category];
    const text =
      `📝 待审核 · ${a.kind === "quick" ? "短想法" : "文章"} · ${cat}\n${a.id} v${v.version_no}\n` +
      (a.kind === "quick" ? "" : `中文：${v.title_zh}\n英文：${v.title_en}\n`) +
      `\n推荐平台（点按钮增减）：\n${lines.join("\n")}\n\n` +
      (qc?.issues?.length ? `翻译检查：${qc.issues.length} 项提示（见预览）\n` : "") +
      (a.kind === "quick" ? "" : `封面：${a.cover_sha ? "自定义图片" : "自动生成"}（替换：发图片并配文 /cover ${a.id}）\n`) +
      `中文 ${v.zh_hash.slice(0, 8)} · 英文 ${v.en_hash!.slice(0, 8)} · 平台内容 ${st.draftsHash.slice(0, 8)}\n\n` +
      `完整预览（中英全文、各平台内容${a.kind === "quick" ? "" : "、封面"}，7 天有效）：\n${await this.previewUrl(v.id)}`;
    const toggles = recs.filter((r) => r.available && !(r.platform === "blog" && a.kind !== "quick")).map((r) => ({ text: `${targets.includes(r.platform) ? "✅" : "⬜"} ${LABEL[r.platform]}`, data: `tp:${a.id}:${r.platform}` }));
    const rows: Array<Array<{ text: string; data: string }>> = [];
    for (let i = 0; i < toggles.length; i += 3) rows.push(toggles.slice(i, i + 3));
    rows.push([{ text: `✅ 批准发布（${targets.length} 个平台）`, data: `ap:${v.id}:${st.hash.slice(0, 16)}` }]);
    rows.push([{ text: "✏️ 改中文", data: `ez:${a.id}` }, { text: "✏️ 改英文", data: `ee:${a.id}` }, { text: "🔁 重译", data: `rt:${a.id}` }]);
    rows.push([{ text: "📊 状态", data: `st:${a.id}` }, { text: "🗑 取消", data: `dc:${a.id}` }]);
    return { text, markup: kb(rows) };
  }

  /** Toggle one platform; the approve button's hash changes with it, so older buttons stop working. */
  async toggleTarget(articleId: string, platform: string, chatId: number, messageId: number): Promise<string> {
    const a = await this.article(articleId);
    const v = a?.current_version_id ? await this.version(a.current_version_id) : null;
    if (!a || !v || a.status !== "in_review") return "当前不在审核中";
    const recs = this.recs(a, v);
    if (!recs.find((r) => r.platform === platform)?.available) return "该平台不可用";
    if (platform === "blog" && a.kind !== "quick") return "正式文章必须发布博客";
    const cur = this.targetsOf(a, v);
    const next = cur.includes(platform) ? cur.filter((p) => p !== platform) : [...cur, platform];
    if (!next.length) return "至少保留一个平台";
    await this.db().prepare("UPDATE articles SET targets=?, updated_at=? WHERE id=?").bind(JSON.stringify(canonicalPlatforms(next)), nowIso(), a.id).run();
    await this.invalidateApprovals(a.id, "targets changed");
    const st = (await this.reviewState(a.id))!;
    const card = await this.reviewCard(st);
    await this.tg.call("editMessageText", { chat_id: chatId, message_id: messageId, text: card.text, reply_markup: card.markup, disable_web_page_preview: true }).catch(() => this.tg.send(chatId, card.text, { reply_markup: card.markup }));
    await this.db().prepare("UPDATE articles SET review_sent_for=? WHERE id=?").bind(`${v.id}|${st.hash.slice(0, 16)}`, a.id).run();
    return `${LABEL[platform]}：${next.includes(platform) ? "已加入" : "已移除"}`;
  }

  /** Replace (or reset with sha=null) the custom cover; it is part of the approved content. */
  async setCover(articleId: string, chatId: number, fileId: string | null, sha: string | null) {
    const a = await this.article(articleId);
    if (!a || a.kind === "quick") return this.tg.send(chatId, "找不到这篇文章（短想法没有封面）");
    await this.db().prepare("UPDATE articles SET cover_file_id=?, cover_sha=?, updated_at=? WHERE id=?").bind(fileId, sha, nowIso(), a.id).run();
    await this.invalidateApprovals(a.id, "cover changed");
    await this.tg.send(chatId, sha ? "封面已替换，需重新审核。" : "已恢复自动封面，需重新审核。");
    if (a.current_version_id && a.status === "in_review") await this.sendReview(a.current_version_id, chatId);
  }

  // ---------- approval ----------
  async approve(userId: number, chatId: number, versionId: string, hashPrefix: string): Promise<string> {
    const v = await this.version(versionId);
    const a = v ? await this.article(v.article_id) : null;
    if (!v || !a) return "版本不存在";

    // Idempotent: a repeated click on an already-accepted approval returns its status.
    const st = await this.reviewState(a.id);
    const platforms = st?.targets ?? [];
    if (st) {
      const existing = await this.db().prepare("SELECT id FROM approvals WHERE approval_hash=?").bind(st.hash).first();
      if (existing && /^[0-9a-f]{16}$/.test(hashPrefix) && st.hash.startsWith(hashPrefix)) return "这个版本已经批准过，正在发布或已发布，不会重复发布";
    }

    const res = await checkApproval({
      requested: { versionId, hashPrefix },
      article: a,
      version: v,
      platforms,
      allowedPlatforms: this.recs(a, v).filter((r) => r.available).map((r) => r.platform),
      draftsHash: st?.draftsHash,
    });
    if (!res.ok) return res.reason;

    const now = nowIso();
    const apId = randomId("ap");
    const stmts = [
      this.db()
        .prepare("INSERT OR IGNORE INTO approvals (id, article_id, version_id, zh_hash, en_hash, platforms, approval_hash, approved_by, approved_at, drafts_json, drafts_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(apId, a.id, v.id, v.zh_hash, v.en_hash, JSON.stringify(platforms), res.hash, userId, now, JSON.stringify(st!.drafts), st!.draftsHash),
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
    await this.say(chatId, `已批准 ${a.id} v${v.version_no}：${platforms.map((p) => LABEL[p] ?? p).join("、")}。完成后发回执。`);
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
      // Lease: only one invocation (cron, webhook) may work on a job at a time.
      const lease = await this.db()
        .prepare("UPDATE publish_jobs SET lease_until=? WHERE id=? AND status='active' AND (lease_until IS NULL OR lease_until<=?)")
        .bind(new Date(Date.now() + LEASE_MS).toISOString(), job.id, nowIso())
        .run();
      if (!lease.meta.changes) continue;
      try {
        if (await this.supersededOrBlocked(job)) continue;
        await this.advanceJob(job);
      } catch (e: any) {
        const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
        await this.jobError(job, timeout ? "请求超时（下次重试前会先核查远端状态）" : String(e?.message ?? e), e instanceof AuthError);
      } finally {
        await this.db().prepare("UPDATE publish_jobs SET lease_until=NULL WHERE id=?").bind(job.id).run();
      }
    }
  }

  private async event(jobId: string, stage: string, ok: boolean, detail: unknown) {
    await this.db().prepare("INSERT INTO publish_events (job_id, stage, ok, detail, at) VALUES (?,?,?,?,?)").bind(jobId, stage, ok ? 1 : 0, typeof detail === "string" ? detail : JSON.stringify(detail), nowIso()).run();
  }

  private async jobError(job: any, msg: string, fatal = false) {
    const attempts = job.attempts + 1;
    const failed = fatal || attempts >= MAX_JOB_ATTEMPTS;
    await this.db()
      .prepare("UPDATE publish_jobs SET attempts=?, last_error=?, status=?, next_attempt_at=?, updated_at=? WHERE id=?")
      .bind(attempts, msg, failed ? "failed" : "active", addSeconds(nowIso(), backoffSeconds(attempts)), nowIso(), job.id)
      .run();
    await this.event(job.id, failed ? "error" : "retry", false, { attempts, msg });
    if (failed) {
      await this.db().prepare("UPDATE articles SET status='publish_failed', updated_at=? WHERE id=?").bind(nowIso(), job.article_id).run();
      if (job.platform === "blog") await this.db().prepare("UPDATE publish_jobs SET status='failed', last_error='博客未发布，跳过', updated_at=? WHERE approval_id=? AND status='active'").bind(nowIso(), job.approval_id).run();
      await this.maybeReceipt(job.approval_id);
    }
  }

  private async wait(job: any, seconds: number, note: string) {
    await this.db().prepare("UPDATE publish_jobs SET next_attempt_at=?, last_error=?, updated_at=? WHERE id=?").bind(addSeconds(nowIso(), seconds), note, nowIso(), job.id).run();
  }

  /**
   * Jobs for the same article and platform run strictly in approval order.
   * An older job that has not touched the remote side yet is dropped when a newer approval exists;
   * a newer job waits while an older one is still in flight.
   */
  async supersededOrBlocked(job: any): Promise<boolean> {
    const newer = await this.db()
      .prepare("SELECT id FROM publish_jobs WHERE article_id=? AND platform=? AND created_at>? AND status IN ('active','done') LIMIT 1")
      .bind(job.article_id, job.platform, job.created_at)
      .first<any>();
    const untouched = job.stage === "queued" && !job.deployment_id && !job.commit_sha;
    if (newer && untouched) {
      await this.db().prepare("UPDATE publish_jobs SET status='cancelled', last_error='已被更新的批准取代', updated_at=? WHERE id=?").bind(nowIso(), job.id).run();
      await this.event(job.id, "superseded", true, { by: newer.id });
      await this.maybeReceipt(job.approval_id);
      return true;
    }
    const older = await this.db()
      .prepare("SELECT id FROM publish_jobs WHERE article_id=? AND platform=? AND created_at<? AND status='active' LIMIT 1")
      .bind(job.article_id, job.platform, job.created_at)
      .first<any>();
    if (older) {
      await this.db().prepare("UPDATE publish_jobs SET next_attempt_at=?, updated_at=? WHERE id=?").bind(new Date(Date.now() + 30_000).toISOString(), nowIso(), job.id).run();
      return true;
    }
    return false;
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
      const drafts = ap.drafts_json ? JSON.parse(ap.drafts_json) : null;
      const cover = drafts?.blog?.cover?.type === "custom" ? drafts.blog.cover.sha as string : null;
      const coverPath = cover ? `/covers/${a.slug}-${cover.slice(0, 8)}.jpg` : undefined;
      const extra = { category: a.category ?? undefined, cover: coverPath };
      const files: Array<{ path: string; content?: string; base64?: string }> = [
        { path: postPath("zh", a.slug), content: renderPostFile({ slug: a.slug, lang: "zh", title: v.title_zh, body: v.body_zh, date, updated: a.first_published_at ? nowIso() : undefined, articleId: a.id, versionId: v.id, versionHash: v.zh_hash, approvalHash: ap.approval_hash, ...extra }) },
        { path: postPath("en", a.slug), content: renderPostFile({ slug: a.slug, lang: "en", title: v.title_en!, body: v.body_en!, date, updated: a.first_published_at ? nowIso() : undefined, articleId: a.id, versionId: v.id, versionHash: v.en_hash!, approvalHash: ap.approval_hash, translationOf: v.zh_hash, ...extra }) },
      ];
      if (cover) {
        if (!a.cover_file_id || a.cover_sha !== cover) throw new Error("封面已在审批后更换，拒绝发布");
        const bytes = await this.downloadTgFile(a.cover_file_id);
        if ((await sha256Bytes(bytes)) !== cover) throw new Error("封面文件与审批不一致");
        files.push({ path: `blog/public${coverPath}`, base64: toBase64(bytes) });
      }
      // Idempotency: if both files already carry this approval hash, a previous attempt committed them.
      const [zhNow, enNow] = await Promise.all(files.slice(0, 2).map((f) => gh.getFileText(f.path, branch)));
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
      return this.maybeReceipt(job.approval_id);
    }
  }

  async retry(articleId: string): Promise<string> {
    const r = await this.db()
      .prepare(
        "UPDATE publish_jobs SET status='active', attempts=0, next_attempt_at=?, updated_at=? WHERE article_id=? AND status='failed' AND approval_id=(SELECT id FROM approvals WHERE article_id=? AND invalidated_at IS NULL ORDER BY approved_at DESC LIMIT 1)",
      )
      .bind(nowIso(), nowIso(), articleId, articleId)
      .run();
    if (!r.meta.changes) return "没有可重试的失败任务";
    await this.db().prepare("UPDATE articles SET status='publishing', updated_at=? WHERE id=?").bind(nowIso(), articleId).run();
    return "已从断点重新开始发布";
  }

  async status(articleId: string): Promise<string> {
    const a = await this.article(articleId);
    if (!a) return "找不到这篇文章";
    const v = a.current_version_id ? await this.version(a.current_version_id) : null;
    const jobs = await this.db().prepare("SELECT platform, stage, status, attempts, commit_sha, public_urls, last_error FROM publish_jobs j WHERE article_id=? AND created_at=(SELECT MAX(created_at) FROM publish_jobs k WHERE k.article_id=j.article_id AND k.platform=j.platform) ORDER BY platform").bind(articleId).all<any>();
    const jl = (jobs.results ?? [])
      .map((j) => `· ${j.platform}: ${j.stage}/${j.status}${j.commit_sha ? ` commit ${j.commit_sha.slice(0, 7)}` : ""}${j.public_urls ? `\n  ${JSON.parse(j.public_urls).join("\n  ")}` : ""}${j.last_error && j.status !== "done" ? `\n  错误：${j.last_error}` : ""}`)
      .join("\n");
    return `${a.id}（${a.kind === "quick" ? "短想法" : "文章"}）\n状态：${a.status}\nslug：${a.slug}\n当前版本：v${v?.version_no ?? "?"}（翻译 ${v?.translation_status ?? "?"}）\n${jl || "暂无发布任务"}`;
  }

  async quota(): Promise<string> {
    const u = await deeplUsage(this.env.DEEPL_API_KEY, this.fetcher);
    const used = await this.db().prepare("SELECT COALESCE(SUM(chars),0) AS n FROM usage_log WHERE provider='deepl'").first<{ n: number }>();
    return `DeepL（免费 :fx 密钥）：已用 ${u.character_count.toLocaleString()} / ${u.character_limit.toLocaleString()} 字符，剩余 ${(u.character_limit - u.character_count).toLocaleString()}\n本系统累计记录消耗：${used?.n ?? 0} 字符\n注意：新开通的 Developer 方案是一次性额度，用完不会重置。额度不足时自动暂停翻译，不会切换付费。`;
  }

  // ---------- Medium: manual takeover ----------
  /** Latest Medium job for an article that is waiting on the browser import (or failed). */
  private async mediumJob(articleId: string) {
    return this.db()
      .prepare("SELECT * FROM publish_jobs WHERE article_id=? AND platform='medium' AND status IN ('active','failed') ORDER BY created_at DESC LIMIT 1")
      .bind(articleId)
      .first<any>();
  }
  /** `/medium <id> <url>`: the user published by hand; record it. `/medium <id> skip`: give up on Medium for this approval. */
  async mediumTakeover(articleId: string, arg: string): Promise<string> {
    const job = await this.mediumJob(articleId);
    if (!job) return "这篇文章没有等待中的 Medium 任务";
    if (/^(skip|跳过|取消)$/i.test(arg)) {
      await this.db().prepare("UPDATE publish_jobs SET status='cancelled', last_error='用户放弃 Medium', updated_at=? WHERE id=?").bind(nowIso(), job.id).run();
      await this.event(job.id, "medium_skip", true, null);
      await this.maybeReceipt(job.approval_id);
      return "已放弃本次 Medium 发布";
    }
    let u: URL;
    try { u = new URL(arg); } catch { return "用法：/medium <编号> <Medium 文章链接>，或 /medium <编号> skip"; }
    if (u.protocol !== "https:" || !/(^|\.)medium\.com$/.test(u.hostname) || u.pathname.length < 3 || /\/(p\/[^/]+\/edit|new-story)/.test(u.pathname)) return "请给已发布的 medium.com 文章链接（不是编辑页）";
    const clean = `${u.origin}${u.pathname}`;
    const dup = await this.db().prepare("SELECT article_id FROM publish_jobs WHERE platform='medium' AND status='done' AND public_urls LIKE ? AND article_id!=?").bind(`%${clean}%`, articleId).first<any>();
    if (dup) return `这个链接已登记在另一篇文章（${dup.article_id}）`;
    await this.db().prepare("UPDATE publish_jobs SET status='done', stage='verified', public_urls=?, remote_id=?, last_error=NULL, updated_at=? WHERE id=?").bind(JSON.stringify([clean]), JSON.stringify({ url: clean, by: "manual" }), nowIso(), job.id).run();
    await this.event(job.id, "medium_manual", true, { url: clean });
    await this.maybeReceipt(job.approval_id);
    return `已登记 Medium：${clean}`;
  }
  /** Instructions for doing the Medium step by hand (sent when the browser import is stuck). */
  async mediumHandoff(job: any): Promise<string> {
    const ap = await this.db().prepare("SELECT drafts_json FROM approvals WHERE id=?").bind(job.approval_id).first<any>();
    const d = ap?.drafts_json ? JSON.parse(ap.drafts_json).medium : null;
    return `Medium 自动导入超过 24 小时未完成（${job.article_id}）。\n可手动：打开 https://medium.com/p/import 导入\n${d?.source ?? "(无来源链接)"}\n发布后发：/medium ${job.article_id} <文章链接>\n不发了：/medium ${job.article_id} skip`;
  }

  // ---------- health ----------
  /** Problems an operator should know about. Each has a stable key so alerts fire once. */
  async health(now = Date.now()): Promise<Array<{ key: string; text: string; job?: any }>> {
    const iso = (ms: number) => new Date(now - ms).toISOString();
    const out: Array<{ key: string; text: string; job?: any }> = [];
    const q = async (sql: string, ...b: any[]) => ((await this.db().prepare(sql).bind(...b).all<any>()).results ?? []);
    for (const j of await q("SELECT * FROM publish_jobs WHERE status='failed' AND updated_at>=?", iso(7 * 86400_000)))
      out.push({ key: `failed:${j.id}`, text: `${PLATFORM_LABEL[j.platform] ?? j.platform} 发布失败（${j.article_id}）：${String(j.last_error ?? "").slice(0, 100)}。/retry ${j.article_id}` });
    for (const j of await q("SELECT * FROM publish_jobs WHERE status='active' AND stage!='external' AND created_at<=?", iso(2 * 3600_000)))
      out.push({ key: `stuck:${j.id}`, text: `${PLATFORM_LABEL[j.platform] ?? j.platform} 任务超过 2 小时未完成（${j.article_id}，阶段 ${j.stage}，已试 ${j.attempts} 次）` });
    for (const j of await q("SELECT * FROM publish_jobs WHERE status='active' AND stage='external' AND updated_at<=?", iso(24 * 3600_000)))
      out.push({ key: `medium:${j.id}`, text: await this.mediumHandoff(j), job: j });
    for (const a of await q("SELECT id FROM articles WHERE status='awaiting_proofread' AND updated_at<=?", iso(2 * 3600_000)))
      out.push({ key: `proofread:${a.id}`, text: `英文校对超过 2 小时未完成（${a.id}），校对任务可能停了` });
    for (const u of await q("SELECT update_id FROM seen_updates WHERE status='failed' AND at>=?", iso(7 * 86400_000)))
      out.push({ key: `update:${u.update_id}`, text: `有一条 Telegram 消息处理中断且无法自动恢复（update ${u.update_id}），请重发` });
    return out;
  }

  async downloadTgFile(fileId: string): Promise<Uint8Array> {
    const f = await this.tg.call("getFile", { file_id: fileId });
    const r = await this.fetcher(`https://api.telegram.org/file/bot${this.env.TELEGRAM_BOT_TOKEN}/${f.file_path}`);
    if (!r.ok) throw new Error(`下载封面失败：HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
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

export function htmlToText(h: string): string {
  return h.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "$2 $1").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
export function chunkText(t: string, n: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of t.split("\n\n")) {
    if (cur && cur.length + para.length + 2 > n) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${para}` : para;
    while (cur.length > n) { out.push(cur.slice(0, n)); cur = cur.slice(n); }
  }
  if (cur) out.push(cur);
  return out;
}
export async function sha256Bytes(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
