// Public identity (user, 2026-11-05). No real name anywhere on the site.
export const SITE = {
  name: { zh: "砚舟", en: "Inkward" },
  mark: "砚舟 / INKWARD",
  description: { zh: "写作、学习与思考", en: "Writing, learning and thinking" },
  author: { zh: "砚舟", en: "Inkward" },
};
// Production builds are indexable only on the production branch.
export const IS_PRODUCTION = (process.env.CF_PAGES_BRANCH ?? "main") === "main";

export const SITE_URL = (process.env.SITE_URL || "https://personal-bilingual-blog.pages.dev").replace(/\/$/, "");
// Privacy-friendly page-view counter on the publishing Worker (no cookies, no IP stored).
export const HIT_URL = "https://pbb-writer.geochelone666.workers.dev/hit";
/** Plain-text excerpt of a markdown body. */
export function excerpt(md: string | undefined, n = 150): string {
  const t = (md ?? "").replace(/```[\s\S]*?```/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`~-]+/g, " ").replace(/\s+/g, " ").trim();
  const c = [...t];
  return c.length > n ? c.slice(0, n).join("").trim() + "…" : t;
}
