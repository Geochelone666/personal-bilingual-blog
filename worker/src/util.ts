export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const rnd = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}_${d}_${rnd}`;
}

export function zhHashInput(title: string, body: string): string {
  return `${title.trim()}\n${normalizeBody(body)}`;
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** Split a Telegram message into title + body. First line is the title ("# " optional). */
export function splitTitleBody(text: string): { title: string; body: string } | null {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return null;
  const lines = t.split("\n");
  const title = lines[0].replace(/^#+\s*/, "").trim();
  const body = lines.slice(1).join("\n").trim();
  if (!title || !body) return null;
  return { title, body };
}

/** Stable, ASCII slug. Chinese titles get a date + short hash slug. */
export function makeSlug(titleEn: string | null, fallbackHash: string): string {
  const d = new Date().toISOString().slice(0, 10);
  const base = (titleEn ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/-$/, "");
  return base ? `${d}-${base}` : `${d}-${fallbackHash.slice(0, 8)}`;
}

export function backoffSeconds(attempts: number): number {
  // 1m, 2m, 4m, 8m ... capped at 1h
  return Math.min(3600, 60 * 2 ** Math.max(0, attempts - 1));
}

export function addSeconds(iso: string, s: number): string {
  return new Date(new Date(iso).getTime() + s * 1000).toISOString();
}

/** DeepL sometimes joins sentences from unspaced Chinese input ("progress.Technological"). */
export function fixSentenceSpacing(s: string): string {
  return s.replace(/([a-z0-9][.!?]|[.!?][)\u201d\u2019"])(?=[A-Z\u201c])/g, "$1 ");
}
