/** Builds the Markdown files committed to the blog repo, and the protected preview HTML. */

export interface PostFileInput {
  slug: string;
  lang: "zh" | "en";
  title: string;
  body: string;
  date: string; // first publish date (ISO)
  updated?: string;
  articleId: string;
  versionId: string;
  versionHash: string; // zh_hash for zh, en_hash for en
  approvalHash: string;
  translationOf?: string; // for en: zh hash it was approved against
  category?: string;
  cover?: string; // site path of a custom cover image
  kind?: string; // "quick" marks a short thought
}

function yamlStr(s: string): string {
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

export function postPath(lang: "zh" | "en", slug: string): string {
  return `blog/src/content/posts/${lang}/${slug}.md`;
}

export function publicPostUrl(siteUrl: string, lang: "zh" | "en", slug: string): string {
  return `${siteUrl.replace(/\/$/, "")}/${lang}/posts/${slug}/`;
}

export function renderPostFile(p: PostFileInput): string {
  const fm = [
    "---",
    `title: ${yamlStr(p.title)}`,
    `lang: ${p.lang}`,
    `postSlug: ${yamlStr(p.slug)}`,
    `date: ${p.date}`,
    p.updated ? `updated: ${p.updated}` : null,
    `articleId: ${yamlStr(p.articleId)}`,
    `versionId: ${yamlStr(p.versionId)}`,
    `versionHash: ${yamlStr(p.versionHash)}`,
    `approvalHash: ${yamlStr(p.approvalHash)}`,
    p.translationOf ? `translationOf: ${yamlStr(p.translationOf)}` : null,
    p.kind === "quick" ? `kind: quick` : null,
    p.category ? `category: ${yamlStr(p.category)}` : null,
    p.cover ? `cover: ${yamlStr(p.cover)}` : null,
    "---",
    "",
  ].filter((l) => l !== null);
  return `${fm.join("\n")}${p.body.trim()}\n`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CAT_EN: Record<string, string> = { dev: "Programming", ai: "AI & Tech", finance: "Markets", politics: "Politics & Society", essay: "Essay" };
const CAT_ZH: Record<string, string> = { dev: "编程", ai: "AI 科技", finance: "投资", politics: "社会观察", essay: "随笔" };

/** Same layout as the blog's generated OG cover, as SVG for the preview page. */
export function coverSvg(title: string, lang: "zh" | "en", category: string): string {
  const max = lang === "zh" ? 14 : 26;
  const words = lang === "zh" ? [...title] : title.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = lang === "zh" ? cur + w : cur ? `${cur} ${w}` : w;
    if ([...next].length > max && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  const shown = lines.slice(0, 3);
  if (lines.length > 3) shown[2] = shown[2].replace(/.{0,1}$/, "…");
  const tag = lang === "zh" ? CAT_ZH[category] ?? "随笔" : CAT_EN[category] ?? "Essay";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="100%"><rect width="1200" height="630" fill="#f6f1e7"/><rect x="0" y="0" width="18" height="630" fill="#1f2328"/>
<text x="80" y="110" font-size="34" fill="#8a6d3b" font-family="system-ui,'PingFang SC','Noto Sans SC',sans-serif">${esc(tag)}</text>
${shown.map((l, i) => `<text x="80" y="${230 + i * 92}" font-size="72" font-weight="700" fill="#1f2328" font-family="system-ui,'PingFang SC','Noto Sans SC',sans-serif">${esc(l)}</text>`).join("")}
<text x="80" y="570" font-size="32" fill="#555" font-family="system-ui,'PingFang SC','Noto Sans SC',sans-serif">砚舟 / INKWARD</text></svg>`;
}

export function renderPreviewHtml(v: {
  articleId: string;
  versionNo: number;
  titleZh: string;
  bodyZh: string;
  titleEn: string;
  bodyEn: string;
  zhHash: string;
  enHash: string;
  qc: { ok: boolean; issues: Array<{ severity: string; detail: string }> } | null;
  kind?: string;
  category?: string;
  drafts?: Record<string, any> | null;
  draftsHash?: string | null;
  coverUrl?: string | null;
}): string {
  const qc = v.qc
    ? v.qc.issues.length
      ? `<ul>${v.qc.issues.map((i) => `<li class="${i.severity}">${esc(i.detail)}</li>`).join("")}</ul>`
      : "<p>未发现问题</p>"
    : "<p>无</p>";
  const d = v.drafts ?? {};
  const blocks: string[] = [];
  const pre = (t: string) => `<pre class="b">${esc(t)}</pre>`;
  const strip = (h: string) => h.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "$2 [$1]").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  if (d.blog) {
    const cover = v.coverUrl
      ? `<img src="${esc(v.coverUrl)}" alt="cover" style="max-width:100%;border-radius:8px">`
      : `<div class="cols"><div>${coverSvg(v.titleZh, "zh", v.category ?? "essay")}</div><div>${coverSvg(v.titleEn, "en", v.category ?? "essay")}</div></div>`;
    blocks.push(`<section><h3>封面 / 分享卡片（${v.coverUrl ? "自定义" : "自动生成"}）</h3>${cover}</section>`);
    blocks.push(`<section><h3>博客</h3><p class="meta">${esc(d.blog.zh.url ?? "")}<br>${esc(d.blog.en.url ?? "")}</p></section>`);
  }
  for (const p of ["telegram", "telegram_en"]) if (d[p]) blocks.push(`<section><h3>${p === "telegram" ? "Telegram 中文频道" : "Telegram 英文频道"}（${d[p].messages.length} 条）</h3>${d[p].messages.map((m: string) => pre(strip(m))).join("<hr>")}</section>`);
  if (d.bluesky) blocks.push(`<section><h3>Bluesky（${d.bluesky.posts.length} 条${d.bluesky.posts.length > 1 ? " Thread" : ""}）</h3>${d.bluesky.posts.map((x: string, i: number) => `<p class="meta">${i + 1} · ${[...x].length} 字符</p>${pre(x)}`).join("")}${d.bluesky.embedUrl ? `<p class="meta">末帖附链接卡片：${esc(d.bluesky.embedUrl)}</p>` : ""}</section>`);
  if (d.medium) blocks.push(`<section><h3>Medium</h3><p>英文全文导入（标题：${esc(d.medium.title)}），canonical：${esc(d.medium.canonical)}</p></section>`);
  if (d.devto) blocks.push(`<section><h3>DEV</h3><p class="meta">标签：${esc(d.devto.tags.join(", "))} · canonical：${esc(d.devto.canonical)}</p>${pre(d.devto.body)}</section>`);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览 · ${esc(v.titleZh)}</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:1100px;margin:auto;padding:16px;color:#222}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:800px){.cols{grid-template-columns:1fr}}
pre.b{white-space:pre-wrap;word-break:break-word;font:inherit}h2{font-size:1.3em}h3{margin:4px 0 8px}.meta{color:#777;font-size:13px}
.warn{color:#b45309}.info{color:#555}section{border:1px solid #eee;border-radius:8px;padding:12px;margin:12px 0}hr{border:0;border-top:1px dashed #ddd}</style></head><body>
<p class="meta">受保护预览 · 未公开 · ${esc(v.articleId)} v${v.versionNo} · ${v.kind === "quick" ? "短想法" : "文章"}<br>zh ${v.zhHash.slice(0, 12)} · en ${v.enHash.slice(0, 12)}${v.draftsHash ? ` · 平台内容 ${v.draftsHash.slice(0, 12)}` : ""}</p>
<section><b>翻译检查</b>${qc}</section>
<div class="cols"><section><h2>${esc(v.titleZh)}</h2><pre class="b">${esc(v.bodyZh)}</pre></section>
<section><h2>${esc(v.titleEn)}</h2><pre class="b">${esc(v.bodyEn)}</pre></section></div>
${blocks.length ? `<h2>各平台拟发布内容</h2>${blocks.join("\n")}` : ""}</body></html>`;
}
