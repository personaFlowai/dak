/* The merge queue: approved PRs on their way to production. Merge scripts push each step
   (`dak queue set 2427 --state testing --eta 4m`), so "how many approved but not merged, and
   how long until they are?" is a page, not a table someone writes.

   Who approved a PR is never typed in: it is read from the PR's Dak thread, so the page can
   only say "Approved by you" when you did. */
import { loadConfig, person } from "./config";
import { store, threadForPr } from "./store";
import { DakError } from "./types";

export const STATES = ["approved", "testing", "building", "merging", "merged", "migrated", "deployed", "failed", "held"] as const;
export type QueueState = (typeof STATES)[number];
export interface QueueRow {
  pr: number; title: string; head: string | null; migration: string | null; state: QueueState;
  note: string | null; thread_id: string | null; added_at: string; updated_at: string;
  state_since: string; // when it reached this step
  eta_at: string | null; // when the script expects this step to finish
  after_pr: number | null; // waits for this PR first (a stack, a rebase)
  approval: { by: string; at: string } | null; // the person's own approval on the thread, if there is one
}

function ensure() {
  const s = store();
  s.exec(`CREATE TABLE IF NOT EXISTS queue (
    pr INTEGER PRIMARY KEY, title TEXT NOT NULL, head TEXT, migration TEXT, state TEXT NOT NULL,
    note TEXT, thread_id TEXT, added_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const cols = new Set((s.query("PRAGMA table_info(queue)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("state_since")) { s.exec("ALTER TABLE queue ADD COLUMN state_since TEXT"); s.exec("UPDATE queue SET state_since = updated_at"); }
  if (!cols.has("eta_at")) s.exec("ALTER TABLE queue ADD COLUMN eta_at TEXT");
  if (!cols.has("after_pr")) s.exec("ALTER TABLE queue ADD COLUMN after_pr INTEGER");
}

// The person's latest verdict on the thread, when it is an approval and nothing new came after it.
function approvalOn(thread: string | null): QueueRow["approval"] {
  if (!thread) return null;
  const me = person(loadConfig());
  const rows = store().query(`SELECT m.author, m.verdict, m.created_at, (SELECT count(*) FROM attachments a WHERE a.message_id = m.id AND a.type = 'pr') AS prs
    FROM messages m WHERE m.thread_id = ? ORDER BY m.id`).all(thread) as { author: string; verdict: string | null; created_at: string; prs: number }[];
  let ok: QueueRow["approval"] = null;
  for (const r of rows) {
    if (r.author === me && r.verdict) ok = r.verdict === "approve" ? { by: me, at: r.created_at } : null;
    else if (r.author !== me && r.prs) ok = null; // a new version needs a new approval
  }
  return ok;
}

const hydrate = (r: any): QueueRow => ({ ...r, state_since: r.state_since ?? r.updated_at, approval: approvalOn(r.thread_id) });

// Order is when a PR joined; the page groups them. A deployed PR stays a day, so the morning
// view shows what went out overnight.
export function queue(opts: { all?: boolean } = {}): QueueRow[] {
  ensure();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  return (store().query("SELECT * FROM queue ORDER BY added_at, pr").all() as any[])
    .filter((r) => opts.all || r.state !== "deployed" || r.updated_at > dayAgo).map(hydrate);
}

// "4m", "90s", "1h", or a number of minutes.
function minutes(v: string): number {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) throw new DakError("bad_eta", `--eta is how long this step should take: 4m, 90s, 1h.`);
  const n = Number(m[1]);
  return (m[2] ?? "m").toLowerCase() === "s" ? n / 60 : (m[2] ?? "m").toLowerCase() === "h" ? n * 60 : n;
}

export function setQueue(pr: number, v: { state?: string; title?: string; head?: string; migration?: string; note?: string; thread?: string; eta?: string; after?: string | number }): QueueRow {
  ensure();
  if (!Number.isInteger(pr) || pr <= 0) throw new DakError("bad_pr", "Say which PR by its number: dak queue set 2427 --state testing.");
  if (v.state && !STATES.includes(v.state as QueueState)) throw new DakError("bad_state", `A state is one of: ${STATES.join(", ")}.`);
  const now = new Date();
  const old = store().query("SELECT * FROM queue WHERE pr = ?").get(pr) as any;
  const moved = !!v.state && v.state !== old?.state;
  const thread = v.thread ?? old?.thread_id ?? threadForPr(pr);
  const after = v.after === undefined ? old?.after_pr ?? null
    : ["", "none", "0"].includes(String(v.after).replace(/^#/, "")) ? null : Number(String(v.after).replace(/^#/, ""));
  if (after !== null && (!Number.isInteger(after) || after === pr)) throw new DakError("bad_after", "--after is the number of the PR this one waits for, or none.");
  const row = {
    pr, title: v.title ?? old?.title ?? (thread ? subjectOf(thread) : `PR #${pr}`),
    head: v.head ?? old?.head ?? null, migration: v.migration ?? old?.migration ?? null,
    state: (v.state ?? old?.state ?? "approved") as QueueState,
    // A note and an estimate belong to the step they describe: a new step clears them.
    note: v.note ?? (moved ? null : old?.note ?? null),
    eta_at: v.eta !== undefined ? new Date(now.getTime() + minutes(v.eta) * 60_000).toISOString() : moved ? null : old?.eta_at ?? null,
    thread_id: thread, added_at: old?.added_at ?? now.toISOString(), updated_at: now.toISOString(),
    state_since: moved || !old ? now.toISOString() : old.state_since ?? old.updated_at,
    after_pr: after,
  };
  store().query(`INSERT INTO queue (pr, title, head, migration, state, note, thread_id, added_at, updated_at, state_since, eta_at, after_pr)
    VALUES ($pr,$title,$head,$migration,$state,$note,$thread_id,$added_at,$updated_at,$state_since,$eta_at,$after_pr)
    ON CONFLICT(pr) DO UPDATE SET title=$title, head=$head, migration=$migration, state=$state, note=$note, thread_id=$thread_id,
      updated_at=$updated_at, state_since=$state_since, eta_at=$eta_at, after_pr=$after_pr`)
    .run(Object.fromEntries(Object.entries(row).map(([k, x]) => [`$${k}`, x])) as any);
  return hydrate(row);
}

export function removeQueue(pr: number) {
  ensure();
  store().query("DELETE FROM queue WHERE pr = ?").run(pr);
}

// For the page's live refresh: changes when any row does, or a thread gets a verdict.
export function queueStamp(): string {
  ensure();
  return (store().query("SELECT coalesce(max(updated_at), '') || count(*) AS s FROM queue").get() as { s: string }).s;
}

function subjectOf(thread: string): string {
  return (store().query("SELECT subject FROM threads WHERE id = ?").get(thread) as { subject: string } | null)?.subject ?? thread;
}
