/* Reading the person's Linear backlog onto the Board. Read only: Dak never writes to Linear.

   The key is the person's own personal API key, pasted on the Board page. It lives in a file only
   this user can read (~/.dak/linear-key, mode 600), is sent only to api.linear.app, and is never
   shown again, logged, or sent to an agent. Open tickets, and those finished in the last week,
   are copied; Linear's status, labels and milestone come with them. */
import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dakHome } from "./config";
import { upsertTasks, type Task } from "./board";
import { DakError } from "./types";

const keyPath = () => join(dakHome(), "linear-key");
const ENDPOINT = "https://api.linear.app/graphql";
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function linearKey(): string | null {
  try { return existsSync(keyPath()) ? readFileSync(keyPath(), "utf8").trim() || null : null; } catch { return null; }
}

async function gql(key: string, query: string, variables: Record<string, unknown>, fetcher: Fetch): Promise<any> {
  const r = await fetcher(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: key }, body: JSON.stringify({ query, variables }) });
  if (r.status === 401 || r.status === 403) throw new DakError("linear_key", "Linear did not accept that key. Make a new personal API key and paste it again.", 400);
  const body: any = await r.json().catch(() => null);
  if (!r.ok || body?.errors?.length) throw new DakError("linear_error", `Linear said: ${body?.errors?.[0]?.message ?? `HTTP ${r.status}`}`, 502);
  return body.data;
}

// Check a key with the smallest question Linear answers, then keep it.
export async function setLinearKey(key: string, fetcher: Fetch = fetch): Promise<{ connected: true; name: string }> {
  const k = key.trim();
  if (!/^lin_api_[A-Za-z0-9]{20,}$/.test(k)) throw new DakError("linear_key", "That does not look like a Linear personal API key (it starts with lin_api_).");
  const d = await gql(k, "query { viewer { name } }", {}, fetcher);
  writeFileSync(keyPath(), k);
  chmodSync(keyPath(), 0o600);
  return { connected: true, name: d.viewer?.name ?? "" };
}
export function clearLinearKey() { try { unlinkSync(keyPath()); } catch { /* none */ } }

const FIELDS = `pageInfo { hasNextPage endCursor }
    nodes { identifier title url priority updatedAt
      state { name type } labels { nodes { name } } project { name } projectMilestone { name } team { key } }`;
// What changed since the last read, in any state: a ticket moved back from Checking comes back too.
const CHANGED = `query($after: String, $since: DateTimeOrDuration) {
  issues(first: 100, after: $after, filter: { updatedAt: { gt: $since } }) { ${FIELDS} }
}`;
const ISSUES = `query($after: String, $since: DateTimeOrDuration) {
  issues(first: 100, after: $after, filter: { or: [{ state: { type: { in: ["backlog", "unstarted", "started"] } } }, { completedAt: { gt: $since } }] }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title url priority updatedAt
      state { name type } labels { nodes { name } } project { name } projectMilestone { name } team { key } }
  }
}`;

// Copy the backlog. Stops at 2,000 tickets: a backlog bigger than that is not read one page at a time.
// changedSince: only tickets Linear changed after that moment (cheap; every minute). Without it,
// the whole open backlog plus the last week's finished (every half hour, and on Refresh).
export async function syncLinear(fetcher: Fetch = fetch, opts: { changedSince?: string } = {}): Promise<{ count: number }> {
  const key = linearKey();
  if (!key) throw new DakError("no_linear_key", "Paste a Linear key on the Board page first.", 400);
  const since = opts.changedSince ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
  const query = opts.changedSince ? CHANGED : ISSUES;
  const all: Task[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: any = await gql(key, query, { after, since }, fetcher);
    for (const n of d.issues.nodes) all.push({ id: n.identifier, source: "linear", title: n.title, url: n.url, labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
      milestone: n.projectMilestone?.name ?? null, project: n.project?.name ?? null, team: n.team?.key ?? null, state: n.state?.name ?? null,
      state_type: n.state?.type ?? null, priority: n.priority ?? null, updated_at: n.updatedAt ?? null });
    if (!d.issues.pageInfo.hasNextPage) break;
    after = d.issues.pageInfo.endCursor;
  }
  upsertTasks(all);
  return { count: all.length };
}
