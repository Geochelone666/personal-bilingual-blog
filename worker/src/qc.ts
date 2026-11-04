/**
 * Algorithmic translation QC (Algorithm First). No AI involved.
 * Produces warnings shown in the bilingual preview; it never blocks or rewrites.
 */
export interface QcIssue {
  check: string;
  severity: "warn" | "info";
  detail: string;
}
export interface QcReport {
  ok: boolean;
  issues: QcIssue[];
  stats: Record<string, number>;
}

const UNCERTAIN_ZH = ["可能", "也许", "或许", "大概", "似乎", "好像", "不确定", "未必", "恐怕", "应该是", "我猜", "我觉得", "我认为"];
const UNCERTAIN_EN = /\b(may|might|maybe|perhaps|possibly|probably|likely|seems?|appears?|not sure|uncertain|i guess|i think|i believe|i feel|suppose|could)\b/gi;
const NEGATION_ZH = /不|没|无|非|别|未/g;

function countZh(text: string, words: string[]): number {
  return words.reduce((n, w) => n + (text.split(w).length - 1), 0);
}

function numbers(text: string): string[] {
  // Arabic numbers incl. decimals/percent/years. Chinese numerals are not compared.
  return (text.match(/\d+(?:[.,]\d+)*%?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

function blockShape(md: string) {
  return {
    headings: (md.match(/^#{1,6}\s/gm) ?? []).length,
    listItems: (md.match(/^\s*(?:[-*+]|\d+\.)\s/gm) ?? []).length,
    codeFences: (md.match(/^```/gm) ?? []).length,
    links: (md.match(/\]\([^)]+\)/g) ?? []).length,
    quotes: (md.match(/^>\s?/gm) ?? []).length,
  };
}

export function runQc(
  zhTitle: string,
  zhBody: string,
  enTitle: string,
  enBody: string,
  glossary: Array<{ term_zh: string; term_en: string }>,
): QcReport {
  const issues: QcIssue[] = [];
  const zh = `${zhTitle}\n${zhBody}`;
  const en = `${enTitle}\n${enBody}`;
  const zhChars = [...zh.replace(/\s/g, "")].length;
  const enWords = en.split(/\s+/).filter(Boolean).length;

  // 1. Length ratio (English words per Chinese char is typically ~0.5-0.9)
  const ratio = zhChars ? enWords / zhChars : 0;
  if (zhChars > 40 && (ratio < 0.3 || ratio > 1.4)) {
    issues.push({ check: "length_ratio", severity: "warn", detail: `英文词数/中文字数 = ${ratio.toFixed(2)}，可能有漏译或多译` });
  }

  // 2. Numbers preserved
  const enNums = new Set(numbers(en));
  const missing = [...new Set(numbers(zh))].filter((n) => !enNums.has(n));
  if (missing.length) issues.push({ check: "numbers", severity: "warn", detail: `英文中缺少数字：${missing.slice(0, 10).join(", ")}` });

  // 3. Markdown structure preserved
  const a = blockShape(zhBody);
  const b = blockShape(enBody);
  for (const k of Object.keys(a) as Array<keyof typeof a>) {
    if (a[k] !== b[k]) issues.push({ check: `structure_${k}`, severity: "warn", detail: `${k}: 中文 ${a[k]} / 英文 ${b[k]}` });
  }

  // 4. Glossary consistency
  for (const g of glossary) {
    if (zh.includes(g.term_zh) && !en.toLowerCase().includes(g.term_en.toLowerCase())) {
      issues.push({ check: "glossary", severity: "warn", detail: `术语「${g.term_zh}」应译为 "${g.term_en}"` });
    }
  }

  // 5. Uncertainty / hedging preserved (keeps the author's degree of confidence)
  const uzh = countZh(zh, UNCERTAIN_ZH);
  const uen = (en.match(UNCERTAIN_EN) ?? []).length;
  if (uzh >= 2 && uen < Math.ceil(uzh / 2)) {
    issues.push({ check: "hedging", severity: "warn", detail: `中文有 ${uzh} 处不确定表达，英文只检测到 ${uen} 处，语气可能被译得过于肯定` });
  }

  // 6. Untranslated Chinese left in English
  const leftover = (en.match(/[\u4e00-\u9fff]+/g) ?? []).join("");
  if (leftover.length > 0) issues.push({ check: "untranslated", severity: "warn", detail: `英文中残留中文：${leftover.slice(0, 30)}` });

  // 7. Info: negation density (helps spot dropped negations on long opinion pieces)
  const negZh = (zh.match(NEGATION_ZH) ?? []).length;
  const negEn = (en.match(/\b(not|no|never|none|nothing|neither|nor|without|n't)\b|n't/gi) ?? []).length;
  if (negZh >= 4 && negEn < negZh * 0.4) {
    issues.push({ check: "negation", severity: "info", detail: `否定词：中文 ${negZh} / 英文 ${negEn}，建议人工核对否定句` });
  }

  return {
    ok: !issues.some((i) => i.severity === "warn"),
    issues,
    stats: { zhChars, enWords, uncertainZh: uzh, uncertainEn: uen },
  };
}
