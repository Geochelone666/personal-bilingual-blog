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
    "---",
    "",
  ].filter((l) => l !== null);
  return `${fm.join("\n")}${p.body.trim()}\n`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
}): string {
  const qc = v.qc
    ? v.qc.issues.length
      ? `<ul>${v.qc.issues.map((i) => `<li class="${i.severity}">${esc(i.detail)}</li>`).join("")}</ul>`
      : "<p>未发现问题</p>"
    : "<p>无</p>";
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览 · ${esc(v.titleZh)}</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:1100px;margin:auto;padding:16px;color:#222}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}@media(max-width:800px){.cols{grid-template-columns:1fr}}
pre.b{white-space:pre-wrap;word-break:break-word;font:inherit}h2{font-size:1.3em}.meta{color:#777;font-size:13px}
.warn{color:#b45309}.info{color:#555}section{border:1px solid #eee;border-radius:8px;padding:12px}</style></head><body>
<p class="meta">受保护预览 · 未公开 · ${esc(v.articleId)} v${v.versionNo}<br>zh ${v.zhHash.slice(0, 12)} · en ${v.enHash.slice(0, 12)}</p>
<section><b>翻译检查</b>${qc}</section>
<div class="cols"><section><h2>${esc(v.titleZh)}</h2><pre class="b">${esc(v.bodyZh)}</pre></section>
<section><h2>${esc(v.titleEn)}</h2><pre class="b">${esc(v.bodyEn)}</pre></section></div></body></html>`;
}
