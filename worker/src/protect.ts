/**
 * Protect Markdown parts that must never be translated (code, URLs, image/link targets,
 * HTML tags) by swapping them for XML placeholders. DeepL is called with
 * tag_handling=xml and ignore_tags=x so placeholders pass through untouched.
 */
export interface Protected {
  text: string;
  slots: string[];
}

const PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g, // fenced code
  /`[^`\n]+`/g, // inline code
  /!\[[^\]]*\]\([^)]+\)/g, // whole image (alt text kept as-is; rarely matters)
  /\]\([^)]+\)/g, // link target "](url)" (link text still translated)
  /<[^>\n]+>/g, // raw html tags
  /https?:\/\/[^\s)<>]+/g, // bare urls
];

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export function protect(md: string, glossary: Array<{ term_zh: string; term_en: string }> = []): Protected {
  const slots: string[] = [];
  let text = md;
  for (const re of PATTERNS) {
    text = text.replace(re, (m) => {
      slots.push(m);
      return `\u0000${slots.length - 1}\u0000`;
    });
  }
  // Glossary: deterministic term substitution (longest term first), so proper nouns
  // are always rendered with the agreed English term.
  for (const g of [...glossary].sort((a, b) => b.term_zh.length - a.term_zh.length)) {
    if (!g.term_zh) continue;
    text = text.split(g.term_zh).join(`\u0000${slots.push(g.term_en) - 1}\u0000`);
  }
  // escape the rest for XML, then materialise placeholders
  text = escapeXml(text).replace(/\u0000(\d+)\u0000/g, (_, i) => `<x i="${i}"/>`);
  return { text, slots };
}

export function restore(xml: string, slots: string[]): string {
  const withMarks = xml.replace(/<x i="(\d+)"\s*\/>/g, (_, i) => `\u0000${i}\u0000`);
  return unescapeXml(withMarks).replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)] ?? "");
}

export function placeholdersIntact(xml: string, slots: string[]): boolean {
  const found = new Set([...xml.matchAll(/<x i="(\d+)"\s*\/>/g)].map((m) => Number(m[1])));
  return slots.every((_, i) => found.has(i));
}
