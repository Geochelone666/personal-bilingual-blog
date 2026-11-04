/** Minimal GitHub REST client for an atomic multi-file commit (git data API). */
const API = "https://api.github.com";

export class GitHub {
  constructor(private token: string, private repo: string, private fetcher: typeof fetch = ((i: any, o?: any) => fetch(i, o)) as typeof fetch) {}

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const r = await this.fetcher(`${API}/repos/${this.repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "personal-bilingual-blog-worker",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.status === 204 ? {} : r.json();
  }

  async getFileText(path: string, ref: string): Promise<string | null> {
    const j = await this.call(`/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
    if (!j || Array.isArray(j) || !j.content) return null;
    const bin = atob(j.content.replace(/\n/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  async latestCommitForPath(path: string, ref: string): Promise<string | null> {
    const j = await this.call(`/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`);
    return j && j[0] ? j[0].sha : null;
  }

  /** Commits all files in one commit on top of the branch head. Returns the new commit sha. */
  async commitFiles(branch: string, files: Array<{ path: string; content: string }>, message: string): Promise<string> {
    const ref = await this.call(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!ref) throw new Error(`分支 ${branch} 不存在`);
    const headSha: string = ref.object.sha;
    const head = await this.call(`/git/commits/${headSha}`);
    const tree = await this.call(`/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: head.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content })),
      }),
    });
    const commit = await this.call(`/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
    });
    // fast-forward only; if the branch moved meanwhile this fails and the job retries
    await this.call(`/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    return commit.sha;
  }
}
