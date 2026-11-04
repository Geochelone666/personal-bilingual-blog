/** Cloudflare Pages deployment lookup, by commit sha. */
export type DeployState =
  | { state: "not_found" }
  | { state: "building"; id: string; stage: string }
  | { state: "success"; id: string; url: string; aliases: string[] }
  | { state: "failed"; id: string; stage: string };

export async function findDeployment(
  opts: { token: string; accountId: string; project: string; commitSha: string; env: "production" | "preview" },
  fetcher: typeof fetch = fetch,
): Promise<DeployState> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/pages/projects/${opts.project}/deployments?env=${opts.env}&per_page=25`;
  const r = await fetcher(url, { headers: { Authorization: `Bearer ${opts.token}` } });
  if (!r.ok) throw new Error(`Cloudflare Pages API HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j: any = await r.json();
  const d = (j.result ?? []).find((x: any) => x?.deployment_trigger?.metadata?.commit_hash === opts.commitSha);
  if (!d) return { state: "not_found" };
  const st = d.latest_stage ?? {};
  if (st.status === "failure" || st.status === "canceled") return { state: "failed", id: d.id, stage: `${st.name}:${st.status}` };
  if (st.name === "deploy" && st.status === "success") return { state: "success", id: d.id, url: d.url, aliases: d.aliases ?? [] };
  return { state: "building", id: d.id, stage: `${st.name}:${st.status}` };
}

export async function retryDeployment(
  opts: { token: string; accountId: string; project: string; deploymentId: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/pages/projects/${opts.project}/deployments/${opts.deploymentId}/retry`;
  const r = await fetcher(url, { method: "POST", headers: { Authorization: `Bearer ${opts.token}` } });
  if (!r.ok) throw new Error(`Pages retry HTTP ${r.status}`);
}

/** Public verification: HTTP 200 and the page carries the exact approved version hash. */
export async function verifyPublicUrl(url: string, versionHash: string, fetcher: typeof fetch = fetch): Promise<{ ok: boolean; detail: string }> {
  const r = await fetcher(url, { headers: { "Cache-Control": "no-cache", "User-Agent": "pbb-verifier" }, redirect: "manual" });
  if (r.status !== 200) return { ok: false, detail: `HTTP ${r.status}` };
  const html = await r.text();
  const marker = `name="pbb-version" content="${versionHash}"`;
  return html.includes(marker) ? { ok: true, detail: "200 + version marker" } : { ok: false, detail: "200 but version marker missing (old build or cache)" };
}
