# personal-bilingual-blog

中文独立博客 + 双语自动发布系统。中文是唯一权威原稿，独立博客是内容主库，外部平台只是分发渠道。

## 当前阶段：P0

Telegram 投稿 → 保存中文草稿（D1）→ DeepL 英文翻译（内容哈希缓存 + 术语表 + 算法质检）→ 受保护双语预览 → 用户批准 → GitHub 提交 → Cloudflare Pages 部署 → 公开 URL 验证 → 回传链接。

```
blog/        Astro 双语静态站（/zh/posts/<slug>/  /en/posts/<slug>/），Cloudflare Pages 托管
worker/      Cloudflare Worker：Telegram Bot Webhook、D1、翻译、审批、发布状态机（每分钟 cron）
docs/        部署与运维说明
```

## 关键保证

| 要求 | 实现 |
| --- | --- |
| 仅本人可投稿/审批 | Webhook secret 校验 + `ALLOWED_TELEGRAM_USER_IDS` 白名单 + 仅私聊 |
| 审批绑定版本 | approval_hash = sha256(version_id, zh_hash, en_hash, 平台清单)；按钮携带哈希前缀，点击时重算比对 |
| 修改即失效 | 任何中文/英文修改生成新版本，旧审批作废，未开始的发布任务取消 |
| 三段式回执 | `github_commit` → `pages_deploy` → `url_verify` 分别记录在 `publish_events`，并分三条消息通知 |
| 幂等 / 不重复发文 | `publish_jobs.idempotency_key` 唯一；提交前检查仓库文件是否已带同一审批哈希；同一文章固定 slug，更新覆盖而非新建 |
| 失败可恢复 | 每个阶段独立重试（指数退避，最多 12 次），失败后 `/retry <编号>` 从断点继续 |
| 不产生费用 | 只接受 `:fx` 免费密钥、只调用 `api-free.deepl.com`；每次翻译前查 `/v2/usage`，额度不足直接暂停 |
| 原稿不丢 | 原稿先入库再翻译；翻译/发布失败不影响原稿 |
| 公开前验证 | 页面需返回 200 且包含 `<meta name="pbb-version" content="<版本哈希>">` |

## 测试

```bash
cd worker && npm install && npm test        # 13 项：单元 + 模拟外部服务的端到端流程
cd blog && npm install && npm run build      # 需要 Node >= 22.23.4（Pages 上用 NODE_VERSION=24）
```

## DeepL 额度说明（2026-11 核实）

DeepL 已停止出售旧的 API Free（每月 50 万字符）。新注册的免费方案是 **API Developer**：密钥同样以 `:fx` 结尾、走 `api-free.deepl.com`，但为 **一次性 100 万字符，用完不重置**。系统以 `/v2/usage` 返回的实时剩余量为准，不假设任何重置。
