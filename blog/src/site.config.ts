// Public identity (user, 2026-11-05). No real name anywhere on the site.
export const SITE = {
  name: { zh: "砚舟", en: "Inkward" },
  mark: "砚舟 / INKWARD",
  description: { zh: "分享一些想法和看法", en: "Sharing some thoughts and views" },
  author: { zh: "砚舟", en: "Inkward" },
};
// Production builds are indexable only on the production branch.
export const IS_PRODUCTION = (process.env.CF_PAGES_BRANCH ?? "main") === "main";

export const SITE_URL = (process.env.SITE_URL || "https://personal-bilingual-blog.pages.dev").replace(/\/$/, "");
// Privacy-friendly page-view counter on the publishing Worker (no cookies, no IP stored).
export const HIT_URL = "https://pbb-writer.geochelone666.workers.dev/hit";
// Reader comments: no account, optional nickname, no approval (user 2026-11-11).
export const COMMENTS_URL = "https://pbb-writer.geochelone666.workers.dev/comments";
/** Plain-text excerpt of a markdown body. */
export function excerpt(md: string | undefined, n = 150): string {
  const t = (md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`~-]+/g, " ").replace(/\s+/g, " ").trim();
  const c = [...t];
  return c.length > n ? c.slice(0, n).join("").trim() + "…" : t;
}

export type Lang = "zh" | "en";
// Category labels, same as the share covers (scripts/og.mjs).
export const CAT: Record<Lang, Record<string, string>> = {
  zh: { dev: "编程", ai: "AI 科技", finance: "投资", politics: "社会观察", essay: "随笔" },
  en: { dev: "Programming", ai: "AI & Tech", finance: "Markets", politics: "Politics & Society", essay: "Essay" },
};
/** Date as the author sees it (Toronto), so a late-evening post keeps its own day. */
export function fmtDate(d: Date, lang: Lang): string {
  return d.toLocaleDateString(lang === "zh" ? "zh-CN" : "en-CA", { timeZone: "America/Toronto", year: "numeric", month: lang === "zh" ? "long" : "short", day: "numeric" });
}
export function isoDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}
/** Minutes to read: ~400 Chinese characters or ~220 English words per minute. */
export function readMins(md: string | undefined, lang: Lang): number {
  const t = excerpt(md, 1e9);
  const n = lang === "zh" ? (t.match(/[\u3400-\u9fff]/g)?.length ?? 0) + t.replace(/[\u3400-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length : t.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(n / (lang === "zh" ? 400 : 220)));
}
export const UI = {
  zh: { search: "搜索", other: "EN", otherFull: "English", all: "全部", quick: "短想法", min: "分钟", read: "阅读", updated: "更新于", none: "还没有文章。", back: "← 全部文章", prev: "上一篇", next: "下一篇", translated: "", top: "回到顶部" },
  en: { search: "Search", other: "中文", otherFull: "中文", all: "All", quick: "Note", min: "min", read: "read", updated: "updated", none: "No posts yet.", back: "← All posts", prev: "Previous", next: "Next", translated: "Translated from Chinese", top: "Back to top" },
};
