import { protect, restore, placeholdersIntact } from "./protect";

/**
 * DeepL API Free client. Hard rules:
 *  - only the Free endpoint (api-free.deepl.com) and only Free keys (":fx");
 *  - check remaining quota before every call; if not enough, pause (no fallback that could bill).
 */
export const DEEPL_FREE_HOST = "https://api-free.deepl.com";

export class QuotaError extends Error {
  constructor(public needed: number, public remaining: number) {
    super(`DeepL 免费额度不足：需要约 ${needed} 字符，剩余 ${remaining}`);
  }
}
export class KeyTypeError extends Error {}

export interface Usage {
  character_count: number;
  character_limit: number;
  // Newer accounts may also return per-period fields; we keep raw for logging.
  raw: unknown;
}

function assertFreeKey(key: string) {
  if (!key || !key.endsWith(":fx")) {
    throw new KeyTypeError("DEEPL_API_KEY 不是 DeepL API Free 密钥（应以 :fx 结尾），为避免产生费用已拒绝调用");
  }
}

export async function deeplUsage(key: string, fetcher: typeof fetch = fetch): Promise<Usage> {
  assertFreeKey(key);
  const r = await fetcher(`${DEEPL_FREE_HOST}/v2/usage`, {
    headers: { Authorization: `DeepL-Auth-Key ${key}` },
  });
  if (!r.ok) throw new Error(`DeepL usage HTTP ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  return { character_count: j.character_count, character_limit: j.character_limit, raw: j };
}

/** Characters DeepL bills = source characters sent (placeholders included). */
export function billableChars(texts: string[]): number {
  return texts.reduce((n, t) => n + [...t].length, 0);
}

export async function translateZhToEn(
  key: string,
  title: string,
  body: string,
  opts: { minRemaining: number; glossary?: Array<{ term_zh: string; term_en: string }>; fetcher?: typeof fetch },
): Promise<{ title: string; body: string; chars: number; actualChars: number | null; usageBefore: Usage; usageAfter: Usage | null }> {
  const fetcher = opts.fetcher ?? fetch;
  assertFreeKey(key);

  const pt = protect(title, opts.glossary);
  const pb = protect(body, opts.glossary);
  const chars = billableChars([pt.text, pb.text]);

  const usage = await deeplUsage(key, fetcher);
  const remaining = usage.character_limit - usage.character_count;
  if (remaining - chars < opts.minRemaining) throw new QuotaError(chars, remaining);

  const params = new URLSearchParams();
  params.append("text", pt.text);
  params.append("text", pb.text);
  params.set("source_lang", "ZH");
  params.set("target_lang", "EN-US");
  params.set("tag_handling", "xml");
  params.set("ignore_tags", "x");
  params.set("preserve_formatting", "1");
  params.set("split_sentences", "nonewlines");

  const r = await fetcher(`${DEEPL_FREE_HOST}/v2/translate`, {
    method: "POST",
    headers: {
      Authorization: `DeepL-Auth-Key ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (r.status === 456) throw new QuotaError(chars, 0); // quota exceeded
  if (!r.ok) throw new Error(`DeepL translate HTTP ${r.status}: ${await r.text()}`);
  const j: any = await r.json();
  const [t, b] = j.translations.map((x: any) => x.text as string);
  if (!placeholdersIntact(t, pt.slots) || !placeholdersIntact(b, pb.slots)) {
    throw new Error("DeepL 返回结果丢失了受保护片段（代码/链接），已拒绝使用该译文");
  }
  // Actual billed characters = usage delta reported by DeepL (estimate kept as fallback).
  let usageAfter: Usage | null = null;
  try {
    usageAfter = await deeplUsage(key, fetcher);
  } catch {
    usageAfter = null;
  }
  const actualChars = usageAfter ? usageAfter.character_count - usage.character_count : null;
  return { title: restore(t, pt.slots).trim(), body: restore(b, pb.slots).trim(), chars, actualChars, usageBefore: usage, usageAfter };
}
