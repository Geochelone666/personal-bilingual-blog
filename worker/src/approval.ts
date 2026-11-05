import { sha256Hex } from "./util";

export function canonicalPlatforms(platforms: readonly string[]): string[] {
  return [...new Set(platforms.map((p) => p.trim().toLowerCase()).filter(Boolean))].sort();
}

/** The approval hash binds the exact version, both text hashes and the platform list. */
export async function approvalHash(versionId: string, zhHash: string, enHash: string, platforms: readonly string[], draftsHash?: string): Promise<string> {
  // v2 also binds the exact per-platform content (drafts incl. cover) that was shown for review.
  if (draftsHash) return sha256Hex(`v2|${versionId}|${zhHash}|${enHash}|${JSON.stringify(canonicalPlatforms(platforms))}|${draftsHash}`);
  return sha256Hex(`v1|${versionId}|${zhHash}|${enHash}|${JSON.stringify(canonicalPlatforms(platforms))}`);
}

export interface ApprovalCheckInput {
  requested: { versionId: string; hashPrefix: string };
  article: { status: string; current_version_id: string | null };
  version: { id: string; zh_hash: string; en_hash: string | null; translation_status: string } | null;
  platforms: readonly string[];
  allowedPlatforms: readonly string[];
  draftsHash?: string;
}

/**
 * Pure decision: may this approval click be accepted?
 * Returns the computed hash on success or a reason on rejection.
 */
export async function checkApproval(i: ApprovalCheckInput): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  if (!i.version) return { ok: false, reason: "版本不存在" };
  if (i.article.current_version_id !== i.requested.versionId || i.version.id !== i.requested.versionId) {
    return { ok: false, reason: "稿件已修改，这个审批按钮已失效，请审核最新版本" };
  }
  if (i.article.status !== "in_review") return { ok: false, reason: `当前状态为 ${i.article.status}，不能批准` };
  if (i.version.translation_status !== "done" || !i.version.en_hash) return { ok: false, reason: "英文译稿未就绪" };
  const plats = canonicalPlatforms(i.platforms);
  if (!plats.length) return { ok: false, reason: "未选择发布平台" };
  const bad = plats.filter((p) => !i.allowedPlatforms.includes(p));
  if (bad.length) return { ok: false, reason: `平台未启用：${bad.join(", ")}` };
  const hash = await approvalHash(i.version.id, i.version.zh_hash, i.version.en_hash, plats, i.draftsHash);
  if (!/^[0-9a-f]{16}$/.test(i.requested.hashPrefix) || !hash.startsWith(i.requested.hashPrefix)) {
    return { ok: false, reason: "审批内容与预览不一致（哈希不匹配），请重新审核" };
  }
  return { ok: true, hash };
}

export function idempotencyKey(articleId: string, platform: string, approvalHashHex: string): string {
  return `${articleId}|${platform}|${approvalHashHex}`;
}
