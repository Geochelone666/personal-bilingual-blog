export interface Env {
  DB: D1Database;
  AI?: any; // Workers AI binding (title generation)

  // --- secrets (wrangler secret put / dashboard) ---
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string; // checked against X-Telegram-Bot-Api-Secret-Token
  DEEPL_API_KEY: string; // must be a Free key (ends with ":fx")
  GITHUB_TOKEN: string; // fine-grained PAT: contents read/write on this one repo only
  CF_API_TOKEN: string; // Cloudflare token with Pages read (deployment status)
  PREVIEW_SIGNING_KEY: string; // HMAC key for protected preview links
  ADMIN_TOKEN: string; // for /admin/* maintenance endpoints
  DEVTO_API_KEY?: string;
  BLUESKY_APP_PASSWORD?: string;

  // --- plain vars (wrangler.toml [vars]) ---
  ALLOWED_TELEGRAM_USER_IDS: string; // comma separated numeric ids
  GITHUB_REPO: string; // owner/name
  GITHUB_BRANCH: string; // branch the Pages project builds for production (or a preview branch in test mode)
  CF_ACCOUNT_ID: string;
  PAGES_PROJECT: string;
  SITE_URL: string; // public base URL of the blog, e.g. https://xxx.pages.dev
  WORKER_URL: string; // public base URL of this worker (for preview links)
  PUBLISH_MODE: string; // "preview" (test branch, not production) | "production"
  ENABLED_PLATFORMS?: string; // e.g. "blog,telegram,devto,bluesky"
  TELEGRAM_CHANNEL?: string; // @username of the Chinese channel
  TELEGRAM_CHANNEL_EN?: string; // @username of the English channel
  BLUESKY_HANDLE?: string;
  PROOFREAD?: string; // "true": translated drafts wait in awaiting_proofread until Hark proofreads the English (user asked 2026-11-05)
  DEEPL_MIN_REMAINING: string; // safety margin in chars, e.g. "2000"
}

export const PLATFORMS_P0 = ["blog"] as const;

export function allowedUsers(env: Env): Set<number> {
  return new Set(
    (env.ALLOWED_TELEGRAM_USER_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}
