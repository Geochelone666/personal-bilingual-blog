# 运维说明（P0）

## 组成
- `worker/`：Cloudflare Worker（Telegram webhook、审核、发布状态机、每分钟 cron 重试）+ D1。
- `blog/`：Astro 双语站，Cloudflare Pages 从 GitHub 构建。`staging` 分支 = 受保护预览（noindex），`main` = 生产。

## 发布三段回执
1. GitHub 提交成功：返回 commit sha。
2. Pages 部署成功：按 commit sha 查到 `success` 的部署。
3. 公开 URL 验证成功：抓取 `/zh/posts/<slug>/` 与 `/en/posts/<slug>/`，页面 `pbb-version` meta 等于已批准版本哈希。
三步分别记录在 `publish_events`，任何一步失败由 cron 从该步重试，不会重复提交（幂等键 = 文章 + 版本哈希 + 目标）。

## 审批规则
批准绑定中文哈希、英文哈希、目标平台清单。任一改动后旧批准作废。只有白名单 Telegram 用户 ID 可投稿与批准。

## 模式
`PUBLISH_MODE=preview`（默认，提交到 `staging`）。切到 `production`（`main`）必须经用户明确同意。

## DeepL
API Developer（免费）：`:fx` 密钥，`api-free.deepl.com`，一次性 100 万字符，不重置。每次翻译前查 `/v2/usage`，余量不足即暂停并通知，不会产生费用。Bot 命令 `/quota` 查看余量。

## Secrets（`wrangler secret put`，不入库）
TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, DEEPL_API_KEY, GITHUB_TOKEN（细粒度 PAT，仅本仓库 Contents 读写）, PREVIEW_SIGNING_KEY, ADMIN_TOKEN。

## 管理端点（需 `Authorization: Bearer ADMIN_TOKEN`）
- `GET /admin/health`：各服务连通性
- `POST /admin/set-webhook`：注册 Telegram webhook

## 本地测试
```
cd worker && npm ci && npx vitest run && npx tsc --noEmit
cd blog && npm ci && npx -y node@24 node_modules/.bin/astro build
```

## P3 (2026-11-05)
- RSS: /zh/rss.xml, /en/rss.xml (full content). Sitemap: /sitemap-index.xml (search/404 excluded), robots.txt points to it.
- SEO: canonical, hreflang zh-CN/en/x-default, description from excerpt, OG/Twitter, JSON-LD BlogPosting, 404 page.
- Search: Pagefind, built in CI (`astro build && pagefind --site dist`), pages /zh/search/, /en/search/.
- Stats: blog pages sendBeacon to Worker /hit (path + referrer host only, no IP/cookies) → D1 page_views. Bot /stats [days]. Weekly digest Mon after 14:00 UTC to owner.
- Backup: Worker commits backup/content.json (articles, versions, jobs, glossary; no Telegram ids) every Monday; Git history = versioned backup. D1 Time Travel covers recent point-in-time restore. Workflow ignores backup/**, worker/**, docs/**.
- Proofreading: PROOFREAD=true → awaiting_proofread; Hark task a538a4ef every 30 min proofreads EN and sets in_review.
- Medium importer caches URLs; when re-importing use ?v=N and reset canonical. Medium limits stories published per 24h (deletes seem to count).

## P4 (2026-11-05)
- AUTO_PUBLISH=false: every post gets a Telegram review card; nothing publishes without the approve button.
- Kinds (deterministic, src/p4.ts detectKind): quick thought (≤280 chars, ≤3 paragraphs, no structure, or `#想法`) → TG zh + TG en + Bluesky (thread if long), no blog. Article (else, or `#文章`) → blog + recommendations.
- Category (keyword rules, classify): dev / ai / finance / politics / essay. DEV only for dev with code or many dev terms. Medium for all article categories. Bluesky: lead sentences + optional 2nd post + link post; never cut mid-sentence. TG: full text if ≤3800 chars else summary + link.
- Review card: platform toggles (tp:), approve (ap: binds version, zh/en hash, targets, drafts hash incl. cover), edit zh/en, retranslate, status, cancel. Preview page shows full zh/en, every platform draft, cover.
- Approval stores drafts_json; publishers post exactly that. Blog first; others wait for verified blog.
- Idempotency: TG pending marker + non-destructive probe (editMessageReplyMarkup) of ids after channel_cursor; Bluesky client-chosen TID rkeys + getRecord before create; dev.to canonical lookup. Timeouts are retried only after the remote check.
- Edits: TG edited in place; dev.to PUT; Bluesky never reposted (no edit API); Medium not auto-synced. Card shows 需同步/无变化.
- Credential errors (dev.to 401, Bluesky auth, Telegram 401/403) fail the job at once (no retries); receipt lists 未成功 + /retry.
- Covers: blog/scripts/og.mjs generates /og/<lang>/<slug>.png at build (satori + resvg + Google Fonts subset, never fails the build). Custom: photo captioned `/cover <id>`; `/cover <id> 默认` resets. Cover is part of the drafts hash.
- Medium: job stage 'external'; Hark hourly task 8b12b5ba imports and marks done in D1.
- Proofreading: translate → awaiting_proofread → Hark task a538a4ef → in_review → cron sends review card.
