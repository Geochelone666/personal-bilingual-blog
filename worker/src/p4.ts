/**
 * P4: deterministic content typing, platform recommendation and per-platform drafts.
 * No AI here: rules decide; DeepL only translates (elsewhere).
 */
import { mdToTgHtml, splitForTelegram } from "./platforms";
import { sha256Hex } from "./util";

export type Kind = "article" | "quick";
export type Category = "dev" | "ai" | "finance" | "politics" | "essay";
export const ALL_PLATFORMS = ["blog", "telegram", "telegram_en", "bluesky", "medium", "devto"] as const;
export const LABEL: Record<string, string> = {
  blog: "博客", telegram: "TG 中文", telegram_en: "TG 英文", bluesky: "Bluesky", medium: "Medium", devto: "DEV",
};
export const CATEGORY_LABEL: Record<Category, string> = { dev: "编程/技术", ai: "AI 科技", finance: "投资/市场", politics: "政治/社会", essay: "随笔" };

// ---------- kind ----------
const QUICK_MAX = 280; // Chinese characters

/** Explicit prefixes win (#想法 / #短 → quick, #文章 → article); otherwise short, flat text is a quick thought. */
export function detectKind(text: string): { kind: Kind; text: string; reason: string } {
  const t = text.trim();
  const m = t.match(/^#(想法|短想法|短|quick|q)\s*\n?/i);
  if (m) return { kind: "quick", text: t.slice(m[0].length).trim(), reason: "标记 #想法" };
  const a = t.match(/^#(文章|长文|article|a)\s*\n?/i);
  if (a) return { kind: "article", text: t.slice(a[0].length).trim(), reason: "标记 #文章" };
  const chars = [...t.replace(/\s/g, "")].length;
  const paras = t.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const structured = /^#{1,6}\s|```|^\s*[-*]\s/m.test(t);
  if (chars <= QUICK_MAX && paras <= 3 && !structured) return { kind: "quick", text: t, reason: `${chars} 字，${paras} 段，按短想法处理` };
  return { kind: "article", text: t, reason: `${chars} 字，按正式文章处理` };
}

// ---------- category ----------
const KW: Record<Exclude<Category, "essay">, RegExp[]> = {
  dev: [/编程|程序员|代码|编译|调试|框架|开源|算法|数据库|前端|后端|部署|重构|bug|API|SDK|Git(Hub)?|TypeScript|JavaScript|Python|Rust|Go语言|Java\b|C\+\+|Linux|命令行|函数|变量|接口|Docker|Kubernetes|Astro|React|Vue|Node/gi],
  ai: [/人工智能|\bAI\b|大模型|模型|LLM|GPT|ChatGPT|OpenAI|Anthropic|\bant\b|Claude|Gemini|DeepSeek|英伟达|Nvidia|算力|智能体|Agent/gi],
  finance: [/股票|股市|科技股|美股|港股|A股|纳斯达克|标普|道琼斯|美联储|加息|降息|利率|通胀|估值|市盈率|财报|营收|利润|IPO|上市|泡沫|投资|仓位|基金|债券|收益率|美元|汇率|做空|买入|卖出/gi],
  politics: [/选举|中期选举|大选|总统|国会|议员|政府|政策|关税|制裁|民主党|共和党|政治|社会|移民|战争|外交|法案|抗议/gi],
};

export function classify(title: string, body: string): { category: Category; scores: Record<string, number>; hasCode: boolean } {
  const text = `${title}\n${title}\n${body}`; // title counts double
  const scores: Record<string, number> = {};
  for (const [k, res] of Object.entries(KW)) scores[k] = res.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0);
  const hasCode = /```|`[^`\n]+`/.test(body);
  if (hasCode) scores.dev += 5;
  const order: Category[] = ["dev", "ai", "finance", "politics"];
  let best: Category = "essay";
  let max = 2; // needs at least 3 hits to leave "essay"
  for (const c of order) if (scores[c] > max) { best = c; max = scores[c]; }
  // AI + markets talk is a markets piece for distribution purposes.
  if (best === "ai" && scores.finance >= scores.ai * 0.6 && scores.finance >= 3) best = "finance";
  return { category: best, scores, hasCode };
}

// ---------- recommendation ----------
export interface Rec { platform: string; recommended: boolean; available: boolean; reason: string }

export function recommend(kind: Kind, category: Category, enabled: readonly string[], devScore = 0, hasCode = false): Rec[] {
  const on = (p: string) => enabled.includes(p);
  const out: Rec[] = [];
  const add = (platform: string, recommended: boolean, reason: string, available = on(platform)) =>
    out.push({ platform, recommended: recommended && available, available, reason: available ? reason : "未启用" });
  if (kind === "quick") {
    add("telegram", true, "短想法，中文全文");
    add("telegram_en", true, "短想法，英文全文");
    add("bluesky", true, "短帖可独立阅读，超长自动拆成 Thread");
    add("blog", false, "短想法不强制扩写成博客", false);
    add("medium", false, "Medium 只发正式文章", false);
    add("devto", false, "DEV 只发技术文章", false);
    return out;
  }
  add("blog", true, "中英文权威主库（必选）");
  add("telegram", true, "中文频道：短文全文，长文摘要+链接");
  add("telegram_en", true, "英文频道：短文全文，长文摘要+链接");
  add("bluesky", true, "独立可读的观点摘要（Thread），末帖附原文");
  const mediumOk = ["ai", "finance", "politics", "essay", "dev"].includes(category);
  add("medium", mediumOk, `英文全文，canonical 指回博客（${CATEGORY_LABEL[category]}）`);
  const devOk = category === "dev" && (hasCode || devScore >= 6);
  add("devto", devOk, devOk ? "技术文章，开发者社区" : `不推荐：${CATEGORY_LABEL[category]}不适合开发者社区`);
  return out;
}

export function defaultTargets(recs: Rec[]): string[] {
  return recs.filter((r) => r.recommended).map((r) => r.platform);
}

// ---------- text helpers ----------
const seg = typeof Intl !== "undefined" && (Intl as any).Segmenter ? new (Intl as any).Segmenter("en", { granularity: "grapheme" }) : null;
export function graphemes(s: string): number {
  return seg ? [...seg.segment(s)].length : [...s].length;
}

export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~>]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Sentences, keeping their punctuation. Works for English and Chinese. */
export function sentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((para) => para.match(/[^.!?。！？]+(?:[.!?。！？]+["'”’）)]*|$)/g) ?? [para])
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Pack whole sentences into chunks of at most `max` graphemes; a single over-long sentence is split on spaces/commas. */
export function pack(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  const joiner = (a: string, b: string) => (a && /[\u4e00-\u9fff。！？，]$/.test(a) && /^[\u4e00-\u9fff]/.test(b) ? "" : a ? " " : "");
  for (let s of sentences(text)) {
    while (graphemes(s) > max) {
      const chars = [...s];
      let cutAt = max;
      for (let i = max; i > max * 0.5; i--) if (/[\s,，;；:：]/.test(chars[i])) { cutAt = i + 1; break; }
      if (cur) { out.push(cur); cur = ""; }
      out.push(chars.slice(0, cutAt).join("").trim());
      s = chars.slice(cutAt).join("").trim();
    }
    const next = cur + joiner(cur, s) + s;
    if (graphemes(next) > max && cur) { out.push(cur); cur = s; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/** Leading whole sentences up to `max` graphemes (never cut mid-sentence; at least one sentence). */
export function lead(text: string, max: number): string {
  const ss = sentences(text);
  let out = "";
  for (const s of ss) {
    const next = out ? (/[\u4e00-\u9fff。！？]$/.test(out) ? out + s : `${out} ${s}`) : s;
    if (graphemes(next) > max && out) break;
    out = next;
    if (graphemes(out) > max) break;
  }
  return out;
}

// ---------- drafts ----------
export interface DraftInput {
  kind: Kind;
  category: Category;
  titleZh: string; bodyZh: string; titleEn: string; bodyEn: string;
  zhUrl?: string; enUrl?: string; // article only
  cover?: { type: "generated" } | { type: "custom"; sha: string };
}
export type Drafts = Record<string, any>;

const BSKY_MAX = 300;
const TG_FULL_MAX = 3800;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function bskyThread(d: DraftInput): string[] {
  if (d.kind === "quick") {
    const body = plainText(d.bodyEn);
    const parts = pack(body, BSKY_MAX - 6);
    return parts.length === 1 ? parts : parts.map((p, i) => `${p} (${i + 1}/${parts.length})`);
  }
  const plain = plainText(d.bodyEn);
  const head = `${d.titleEn}\n\n`;
  const first = lead(plain, BSKY_MAX - graphemes(head));
  const posts = [`${head}${first}`];
  const rest = plain.slice(plain.indexOf(first) + first.length).trim();
  const second = rest ? lead(rest, BSKY_MAX) : "";
  if (second && graphemes(second) >= 80) posts.push(second);
  posts.push(`Full essay: ${d.enUrl}`);
  return posts;
}

export function tgMessages(d: DraftInput, lang: "zh" | "en"): string[] {
  const title = lang === "zh" ? d.titleZh : d.titleEn;
  const body = lang === "zh" ? d.bodyZh : d.bodyEn;
  if (d.kind === "quick") return splitForTelegram(mdToTgHtml(body));
  const url = lang === "zh" ? d.zhUrl! : d.enUrl!;
  const more = lang === "zh" ? "阅读全文" : "Read the full article";
  const full = `<b>${esc(title)}</b>\n\n${mdToTgHtml(body)}\n\n<a href="${esc(url)}">${lang === "zh" ? "博客原文" : "Read on the blog"}</a>`;
  if (full.length <= TG_FULL_MAX) return [full];
  const summary = lead(plainText(body), lang === "zh" ? 260 : 600);
  return [`<b>${esc(title)}</b>\n\n${esc(summary)}\n\n<a href="${esc(url)}">${more} →</a>`];
}

export function devtoTags(bodyZh: string, bodyEn: string): string[] {
  const t = `${bodyZh}\n${bodyEn}`.toLowerCase();
  const tags = ["programming"];
  for (const [tag, re] of [["javascript", /javascript|typescript|node\.?js/], ["python", /python/], ["rust", /\brust\b/], ["webdev", /前端|astro|react|vue|css|html|web\b/], ["ai", /\bai\b|llm|大模型|人工智能/], ["retro", /复古|retro|basic|dos\b/], ["career", /职业|career|求职/]] as const)
    if (re.test(t) && tags.length < 4) tags.push(tag);
  return tags;
}

export function buildDrafts(d: DraftInput, targets: readonly string[]): Drafts {
  const out: Drafts = {};
  for (const p of [...targets].sort()) {
    if (p === "blog") out.blog = { zh: { title: d.titleZh, body: d.bodyZh, url: d.zhUrl }, en: { title: d.titleEn, body: d.bodyEn, url: d.enUrl }, cover: d.cover ?? { type: "generated" } };
    else if (p === "telegram") out.telegram = { messages: tgMessages(d, "zh") };
    else if (p === "telegram_en") out.telegram_en = { messages: tgMessages(d, "en") };
    else if (p === "bluesky") out.bluesky = { posts: bskyThread(d), embedUrl: d.kind === "article" ? d.enUrl : undefined };
    else if (p === "devto") out.devto = { title: d.titleEn, body: `${d.bodyEn}\n\n---\n*Originally published at [${new URL(d.enUrl!).host}](${d.enUrl}). Written in Chinese, translated to English.*`, canonical: d.enUrl, tags: devtoTags(d.bodyZh, d.bodyEn) };
    else if (p === "medium") out.medium = { title: d.titleEn, source: d.enUrl, canonical: d.enUrl, note: "Medium 导入英文全文（浏览器操作），canonical 指回博客" };
  }
  return out;
}

export async function draftHash(drafts: Drafts): Promise<string> {
  return sha256Hex(stableJson(drafts));
}
export async function platformDraftHash(drafts: Drafts, p: string): Promise<string> {
  return sha256Hex(stableJson(drafts[p] ?? null));
}
export function stableJson(o: unknown): string {
  if (Array.isArray(o)) return `[${o.map(stableJson).join(",")}]`;
  if (o && typeof o === "object") return `{${Object.keys(o).filter((k) => (o as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson((o as any)[k])}`).join(",")}}`;
  return JSON.stringify(o ?? null);
}

/** Bluesky record keys chosen up front (TID of the job's creation time + i µs), so a timed-out create can be checked instead of repeated. */
export function tid(ms: number, clockId: number, i: number): string {
  const S32 = "234567abcdefghijklmnopqrstuvwxyz";
  let n = ((BigInt(ms) * 1000n + BigInt(i)) << 10n) | BigInt(clockId & 1023);
  let s = "";
  for (let k = 0; k < 13; k++) { s = S32[Number(n & 31n)] + s; n >>= 5n; }
  return s;
}
