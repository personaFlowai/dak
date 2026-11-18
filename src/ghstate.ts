/* Whether each PR is open, merged or closed, as GitHub says. The Board needs it: a PR closed
   without merging is not open work, and one merged outside the merge queue is live. Read with one
   `gh pr list` per repository Dak has seen PRs from, in the background every two minutes, never on
   a page load; kept in memory, so a restart reads it again. */
import { store } from "./store";

export type GhState = "OPEN" | "MERGED" | "CLOSED";
const states = new Map<number, GhState>();
let running = false;

export const ghState = (n: number | null | undefined): GhState | null => (n ? states.get(n) ?? null : null);

async function run(cmd: string[], cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return code === 0 ? out : null;
  } catch { return null; }
}

export async function refreshGhStates(): Promise<number> {
  if (running || process.env.DAK_NO_GH) return 0;
  running = true;
  try {
    const repos = (store().query(`SELECT DISTINCT json_extract(a.meta, '$.repo') AS repo FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE a.type = 'pr' AND m.created_at > ? AND json_extract(a.meta, '$.repo') IS NOT NULL`).all(new Date(Date.now() - 30 * 86_400_000).toISOString()) as { repo: string }[]).map((r) => r.repo);
    // Worktrees of one repository share its .git: ask GitHub once per repository, not per worktree.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const repo of repos) {
      const common = (await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], repo))?.trim();
      if (!common || seen.has(common)) continue;
      seen.add(common); unique.push(repo);
    }
    let n = 0;
    for (const repo of unique) {
      const out = await run(["gh", "pr", "list", "--state", "all", "--limit", "300", "--json", "number,state"], repo);
      if (!out) continue;
      try { for (const r of JSON.parse(out) as { number: number; state: GhState }[]) { states.set(r.number, r.state); n++; } } catch { /* a bad answer: keep what we had */ }
    }
    return n;
  } finally { running = false; }
}
