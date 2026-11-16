/* The merge queue: approved PRs in order, each with its head, migration and where it is on
   the road to production. Merge scripts push state into it (`dak queue set 2427 --state
   testing`), so "how many approved but not merged?" is a page, not a table someone writes. */
import { store, threadForPr } from "./store";
import { DakError } from "./types";

export const STATES = ["approved", "testing", "building", "merging", "merged", "migrated", "deployed", "failed", "held"] as const;
export type QueueState = (typeof STATES)[number];
export interface QueueRow {
  pr: number; title: string; head: string | null; migration: string | null; state: QueueState;
  note: string | null; thread_id: string | null; added_at: string; updated_at: string;
}

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS queue (
    pr INTEGER PRIMARY KEY, title TEXT NOT NULL, head TEXT, migration TEXT, state TEXT NOT NULL,
    note TEXT, thread_id TEXT, added_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}

// Order is when a PR joined the queue; finished ones drop to the end.
export function queue(opts: { all?: boolean } = {}): QueueRow[] {
  ensure();
  const rows = store().query("SELECT * FROM queue ORDER BY added_at").all() as QueueRow[];
  const done = (r: QueueRow) => r.state === "deployed";
  // A deployed PR stays a day, so the morning view shows what went out overnight.
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  return [...rows.filter((r) => !done(r)), ...rows.filter((r) => done(r) && (opts.all || r.updated_at > dayAgo))];
}

export function setQueue(pr: number, v: { state?: string; title?: string; head?: string; migration?: string; note?: string; thread?: string }): QueueRow {
  ensure();
  if (!Number.isInteger(pr) || pr <= 0) throw new DakError("bad_pr", "Say which PR by its number: dak queue set 2427 --state testing.");
  if (v.state && !STATES.includes(v.state as QueueState)) throw new DakError("bad_state", `A state is one of: ${STATES.join(", ")}.`);
  const now = new Date().toISOString();
  const old = store().query("SELECT * FROM queue WHERE pr = ?").get(pr) as QueueRow | null;
  const thread = v.thread ?? old?.thread_id ?? threadForPr(pr);
  const row: QueueRow = {
    pr, title: v.title ?? old?.title ?? (thread ? subjectOf(thread) : `PR #${pr}`),
    head: v.head ?? old?.head ?? null, migration: v.migration ?? old?.migration ?? null,
    state: (v.state ?? old?.state ?? "approved") as QueueState,
    // A note belongs to the state it explains: a new state without one clears it.
    note: v.note ?? (v.state && v.state !== old?.state ? null : old?.note ?? null),
    thread_id: thread, added_at: old?.added_at ?? now, updated_at: now,
  };
  store().query(`INSERT INTO queue VALUES ($pr,$title,$head,$migration,$state,$note,$thread_id,$added_at,$updated_at)
    ON CONFLICT(pr) DO UPDATE SET title=$title, head=$head, migration=$migration, state=$state, note=$note, thread_id=$thread_id, updated_at=$updated_at`)
    .run(Object.fromEntries(Object.entries(row).map(([k, x]) => [`$${k}`, x])) as any);
  return row;
}

export function removeQueue(pr: number) {
  ensure();
  store().query("DELETE FROM queue WHERE pr = ?").run(pr);
}

// For the page's live refresh: changes when any row does.
export function queueStamp(): string {
  ensure();
  return (store().query("SELECT coalesce(max(updated_at), '') || count(*) AS s FROM queue").get() as { s: string }).s;
}

function subjectOf(thread: string): string {
  return (store().query("SELECT subject FROM threads WHERE id = ?").get(thread) as { subject: string } | null)?.subject ?? thread;
}
