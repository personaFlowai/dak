/* The merge queue: approved PRs on their way to production. Merge scripts push each step
   (`dak queue set 2427 --state testing --eta 4m`), so "how many approved but not merged, and
   how long until they are?" is a page, not a table someone writes.

   Who approved a PR is never typed in: it is read from the PR's Dak thread, so the page can
   only say "Approved by you" when you did. */
import { loadConfig, person } from "./config";
import { getThread, readBlobText, store, threadForPr, type PrSize } from "./store";
import { prStates, type PrState } from "./verdicts";
import { DakError } from "./types";
import { byPriority, ensurePriority, holdOf, nextInQueue, type Hold, prioritizeQueue, tierOf, touchStamp, waitingReason, type Tier } from "./priority";

export const STATES = ["approved", "testing", "building", "merging", "merged", "migrated", "deployed", "failed", "held", "parked"] as const;
export type QueueState = (typeof STATES)[number];
export interface QueueRow {
  pr: number; title: string; head: string | null; migration: string | null; state: QueueState;
  note: string | null; thread_id: string | null; added_at: string; updated_at: string;
  state_since: string; // when it reached this step
  eta_at: string | null; // when the script expects this step to finish
  after_pr: number | null; // waits for this PR first (a stack, a rebase)
  approval: { by: string; at: string; head_sha?: string; diff_blob?: string } | null; // the person's own approval on the thread, if there is one
  size: PrSize | null; // files and lines changed, from the PR on its thread
  tier: Tier; rank: number | null; why: string | null; rank_by: string | null; // priority: see priority.ts
  waiting: string | null; // what the agent says it is waiting on: "a migration renumber"
  pair_id: string | null; // two PRs tested and merged together: "2420+2433"
  waiting_reason: string | null; // the plain-words reason it is not moving, derived or said
  hold: Hold | null; // being reworked (skip it) or parked, from its thread
  head_moved: { from: string; to: string; change: HeadChange | null } | null; // pushed after the approval
}
export type HeadChange = "rebase only" | "content changed";

function ensure() {
  const s = store();
  s.exec(`CREATE TABLE IF NOT EXISTS queue (
    pr INTEGER PRIMARY KEY, title TEXT NOT NULL, head TEXT, migration TEXT, state TEXT NOT NULL,
    note TEXT, thread_id TEXT, added_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const cols = new Set((s.query("PRAGMA table_info(queue)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("state_since")) { s.exec("ALTER TABLE queue ADD COLUMN state_since TEXT"); s.exec("UPDATE queue SET state_since = updated_at"); }
  if (!cols.has("eta_at")) s.exec("ALTER TABLE queue ADD COLUMN eta_at TEXT");
  if (!cols.has("after_pr")) s.exec("ALTER TABLE queue ADD COLUMN after_pr INTEGER");
  // What git said about a moved head, worked out when the merge script reported it: {head, change}.
  if (!cols.has("head_check")) s.exec("ALTER TABLE queue ADD COLUMN head_check TEXT");
  ensurePriority();
}

// The person's approval of this PR on its thread, when nothing new came after it. Read per PR:
// a thread can carry several, and an approval of #2450 says nothing about #2451.
function prOn(thread: string | null, pr: number): PrState | null {
  if (!thread) return null;
  let states: PrState[];
  try { states = prStates(getThread(thread).messages, [person(loadConfig())]); } catch { return null; }
  // A thread whose only changes have no number (--base, --diff) is about this row's PR.
  return states.find((s) => s.number === pr) ?? (states.length === 1 && states[0].number === null ? states[0] : null);
}
function approvalOn(thread: string | null, pr: number): QueueRow["approval"] {
  const s = prOn(thread, pr);
  return s?.verdict === "approve" ? { by: s.by!, at: s.at!, ...(s.approved ?? {}) } : null;
}

const hydrate = (r: any): QueueRow => { const approval = approvalOn(r.thread_id, r.pr); return { ...r, state_since: r.state_since ?? r.updated_at, approval,
  size: r.thread_id ? sizeOf(r.thread_id, r.pr) : null, head_moved: headMoved(r, approval), head_check: undefined,
  hold: r.state === "parked" ? { kind: "parked", note: r.waiting ?? r.note ?? null, at: r.state_since ?? r.updated_at, by: null } : holdOf(r.thread_id) }; };

// The change itself, as git's patch-id sees it: which files, and the lines added and removed.
// Blob ids, hunk positions and context lines move on a rebase without the change changing.
const comparable = (diff: string) => diff.split("\n").filter((l) => l.startsWith("diff --git") || ((l[0] === "+" || l[0] === "-") && !/^(\+\+\+|---) /.test(l))).join("\n");

// Has the PR moved since the person approved it, and is it the same change? The current head is
// the merge script's (--head), else the thread's newest snapshot. Same diff after a rebase: same change.
function headMoved(r: any, approval: QueueRow["approval"]): QueueRow["head_moved"] {
  if (!approval?.head_sha || !r.thread_id) return null;
  const meta = metaOf(r.thread_id, r.pr);
  const current: string | null = r.head ?? meta?.head_sha ?? null;
  if (!current || current.startsWith(approval.head_sha) || approval.head_sha.startsWith(current)) return null;
  let change: HeadChange | null = null;
  const check = r.head_check ? JSON.parse(r.head_check) : null;
  if (check?.head === current) change = check.change ?? null;
  else if (meta?.head_sha === current && approval.diff_blob && meta.diff_blob) {
    try { change = comparable(readBlobText(approval.diff_blob)) === comparable(readBlobText(meta.diff_blob)) ? "rebase only" : "content changed"; } catch { /* a blob gone: unknown */ }
  }
  return { from: approval.head_sha, to: current, change };
}

/* For the merge script's --head (CLI only: it runs gh or git). Same change = the same diff as the
   one approved, ignoring blob ids and line positions, which a rebase moves. Null when it cannot
   tell here (no repo, GitHub on another head). Stored, so the page never runs a command. */
export function checkHead(pr: number, head: string, run: (cmd: string[], cwd: string) => string | null) {
  ensure();
  const r = store().query("SELECT * FROM queue WHERE pr = ?").get(pr) as any;
  const approval = r ? approvalOn(r.thread_id, r.pr) : null;
  if (!r || !approval?.head_sha || head.startsWith(approval.head_sha)) return;
  const meta = metaOf(r.thread_id, r.pr);
  const repo = meta?.repo;
  let change: HeadChange | null = null;
  const same = (diff: string | null) => diff === null || !approval.diff_blob ? null : comparable(diff) === comparable(readBlobText(approval.diff_blob)) ? "rebase only" : "content changed";
  if (repo && meta.number) {
    // A GitHub PR: its diff as GitHub has it now, if GitHub's head is the one reported.
    const now = run(["gh", "pr", "view", String(meta.number), "--json", "headRefOid", "-q", ".headRefOid"], repo)?.trim();
    if (now && (now.startsWith(head) || head.startsWith(now))) change = same(run(["gh", "pr", "diff", String(meta.number)], repo));
  } else if (repo && meta.base_ref) {
    // A branch sent with --base: diff the new head from where it forks off that base.
    const mb = run(["git", "merge-base", meta.base_ref, head], repo)?.trim();
    change = same(mb ? run(["git", "diff", "--no-color", "--find-renames", `${mb}...${head}`], repo) : null);
  }
  store().query("UPDATE queue SET head_check = ? WHERE pr = ?").run(JSON.stringify({ head, change }), pr);
}

// This PR's newest snapshot on its thread (not the thread's newest PR, which may be another).
function metaOf(thread: string | null, pr: number): any {
  const s = prOn(thread, pr);
  if (!s) return null;
  const a = getThread(thread!).messages.flatMap((m) => m.attachments).find((x) => x.id === s.att);
  return a?.meta ?? null;
}
function sizeOf(thread: string, pr: number): PrSize | null {
  const files = (metaOf(thread, pr)?.files ?? null) as { additions: number; deletions: number }[] | null;
  return files ? { files: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0) } : null;
}

// In priority order: tier, then the order set inside it, then when a PR joined. A deployed PR
// stays a day, so the morning view shows what went out overnight.
export function queue(opts: { all?: boolean } = {}): QueueRow[] {
  ensure();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const all = store().query("SELECT * FROM queue").all() as any[];
  return all.filter((r) => opts.all || r.state !== "deployed" || r.updated_at > dayAgo)
    .map((r) => ({ ...hydrate(r), waiting_reason: waitingReason(r, all) }))
    // A row being reworked or parked sinks below the rest; it is not what anyone acts on next.
    .sort((a, b) => Number(!!a.hold) - Number(!!b.hold) || byPriority(a, b, (x, y) => x.added_at.localeCompare(y.added_at) || x.pr - y.pr));
}

// The next PR (or pair) the merge loop should take; null when nothing is ready.
export function next(): QueueRow[] | null {
  ensure();
  // A PR about to change is not merged as it stands: skip it until its next version.
  const prs = nextInQueue((store().query("SELECT * FROM queue").all() as any[]).filter((r) => !holdOf(r.thread_id)));
  return prs ? queue().filter((r) => prs.includes(r.pr)) : null;
}

// "4m", "90s", "1h", or a number of minutes.
function minutes(v: string): number {
  const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/i);
  if (!m) throw new DakError("bad_eta", `--eta is how long this step should take: 4m, 90s, 1h.`);
  const n = Number(m[1]);
  return (m[2] ?? "m").toLowerCase() === "s" ? n / 60 : (m[2] ?? "m").toLowerCase() === "h" ? n * 60 : n;
}

export function setQueue(pr: number, v: { state?: string; title?: string; head?: string; migration?: string; note?: string; thread?: string; eta?: string; after?: string | number;
  tier?: string; why?: string; waiting?: string; by?: string }): QueueRow {
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
  // What it waits on belongs to its step, like the note: a new step clears it, and so does "none".
  const waiting = v.waiting !== undefined ? (["", "none"].includes(v.waiting.trim()) ? null : v.waiting.trim()) : moved ? null : old?.waiting ?? null;
  store().query(`INSERT INTO queue (pr, title, head, migration, state, note, thread_id, added_at, updated_at, state_since, eta_at, after_pr, waiting)
    VALUES ($pr,$title,$head,$migration,$state,$note,$thread_id,$added_at,$updated_at,$state_since,$eta_at,$after_pr,$waiting)
    ON CONFLICT(pr) DO UPDATE SET title=$title, head=$head, migration=$migration, state=$state, note=$note, thread_id=$thread_id,
      updated_at=$updated_at, state_since=$state_since, eta_at=$eta_at, after_pr=$after_pr, waiting=$waiting`)
    .run(Object.fromEntries(Object.entries({ ...row, waiting }).map(([k, x]) => [`$${k}`, x])) as any);
  if (v.tier !== undefined || v.why !== undefined) prioritizeQueue(pr, v.by ?? person(loadConfig()), { tier: tierOf(v.tier), why: v.why });
  return queue({ all: true }).find((r) => r.pr === pr)!;
}

export function inQueue(pr: number): { state: string; thread_id: string | null } | null {
  ensure();
  return store().query("SELECT state, thread_id FROM queue WHERE pr = ?").get(pr) as any ?? null;
}

export function removeQueue(pr: number) {
  ensure();
  store().query("DELETE FROM queue WHERE pr = ?").run(pr);
}

// For the page's live refresh: changes when any row does, or a thread gets a verdict.
export function queueStamp(): string {
  ensure();
  return (store().query("SELECT coalesce(max(updated_at), '') || count(*) AS s FROM queue").get() as { s: string }).s + touchStamp();
}

function subjectOf(thread: string): string {
  return (store().query("SELECT subject FROM threads WHERE id = ?").get(thread) as { subject: string } | null)?.subject ?? thread;
}
