/* Priorities: what merges first, and what the person reviews first. Three tiers (urgent,
   normal, later) with an order inside each. Agents set them; the person can drag rows, and
   their order wins: an agent reordering leaves the person's rows where the person put them.
   `dak queue next` reads the result, so a merge loop asks Dak what is next instead of
   chaining scripts by hand. */
import { loadConfig, person } from "./config";
import { addMessage, awaitingReview, store, threadForPr, type AwaitingReview } from "./store";
import { DakError } from "./types";

export const TIERS = ["urgent", "normal", "later"] as const;
export type Tier = (typeof TIERS)[number];
export interface Priority { tier: Tier; rank: number | null; why: string | null; rank_by: string | null }

export function ensurePriority() {
  const s = store();
  // The queue may not exist yet (a review priority set before anything was queued).
  s.exec(`CREATE TABLE IF NOT EXISTS queue (
    pr INTEGER PRIMARY KEY, title TEXT NOT NULL, head TEXT, migration TEXT, state TEXT NOT NULL,
    note TEXT, thread_id TEXT, added_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const cols = new Set((s.query("PRAGMA table_info(queue)").all() as { name: string }[]).map((c) => c.name));
  for (const [c, type] of [["tier", "TEXT NOT NULL DEFAULT 'normal'"], ["rank", "INTEGER"], ["why", "TEXT"], ["rank_by", "TEXT"], ["waiting", "TEXT"], ["pair_id", "TEXT"]]) {
    if (!cols.has(c)) s.exec(`ALTER TABLE queue ADD COLUMN ${c} ${type}`);
  }
  // Review order lives on the thread: a PR waiting for review is not in the merge queue yet.
  s.exec(`CREATE TABLE IF NOT EXISTS review_order (thread_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'normal',
    rank INTEGER, why TEXT, rank_by TEXT, updated_at TEXT NOT NULL)`);
  // type: what kind of answer the agent says it needs; blocks: what the answer releases.
  const rcols = new Set((s.query("PRAGMA table_info(review_order)").all() as { name: string }[]).map((c) => c.name));
  if (!rcols.has("type")) s.exec("ALTER TABLE review_order ADD COLUMN type TEXT");
  if (!rcols.has("blocks")) s.exec("ALTER TABLE review_order ADD COLUMN blocks TEXT");
  // A hold: the agent says not to review it now. "rework" (it is about to change; it comes back by
  // itself with the next version) or "parked" (the person's choice; it stays until unparked).
  for (const c of ["hold", "hold_note", "hold_at", "hold_by"]) if (!rcols.has(c)) s.exec(`ALTER TABLE review_order ADD COLUMN ${c} TEXT`);
}

export type HoldKind = "rework" | "parked";
export interface Hold { kind: HoldKind; note: string | null; at: string; by: string | null }

// A thread's hold, if it still stands. A rework hold ends when a new version of the PR arrives
// after it: the PR is back for review without anyone having to remember to lift it.
export function holdOf(threadId: string | null, row?: any): Hold | null {
  if (!threadId) return null;
  ensurePriority();
  const r = row ?? store().query("SELECT hold, hold_note, hold_at, hold_by FROM review_order WHERE thread_id = ?").get(threadId) as any;
  if (!r?.hold) return null;
  if (r.hold === "rework") {
    const newer = store().query(`SELECT 1 FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.thread_id = ? AND a.type = 'pr' AND m.created_at > ? LIMIT 1`).get(threadId, r.hold_at);
    if (newer) return null;
  }
  if (r.hold === "parked" && parkedBackBy(threadId, r)) return null;
  return { kind: r.hold, note: r.hold_note ?? null, at: r.hold_at, by: r.hold_by ?? null };
}

/* The person parked it, and the sender has since sent something new to answer: a new version of a
   PR or doc, buttons, or a question. That brings it back on its own, so nothing parked waits
   unseen after it changed. A plain reply ("ok, parked") does not. Parks an agent set stay until
   unparked, as before. Returns what brought it back, or null. */
export function parkedBackBy(threadId: string, r?: any): string | null {
  const row = r ?? store().query("SELECT hold, hold_at, hold_by FROM review_order WHERE thread_id = ?").get(threadId) as any;
  if (row?.hold !== "parked" || !row.hold_at || row.hold_by !== me()) return null;
  const m = store().query(`SELECT m.verdict, m.options, (SELECT group_concat(a.type) FROM attachments a WHERE a.message_id = m.id) AS atts
    FROM messages m WHERE m.thread_id = ? AND m.author != ? AND m.created_at > ?
      AND (m.options IS NOT NULL OR m.verdict = 'question' OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.type IN ('pr', 'doc')))
    ORDER BY m.id LIMIT 1`).get(threadId, row.hold_by, row.hold_at) as { verdict: string | null; options: string | null; atts: string | null } | null;
  if (!m) return null;
  return m.atts?.match(/pr|doc/) ? "a new version" : "a new question";
}

// Put a hold on (kind) or take it off (null). Anyone may: it says what is true about the work.
export function setHold(ref: string, kind: HoldKind | null, note: string | null, by: string): string {
  ensurePriority();
  const id = threadFor(ref);
  const at = new Date().toISOString();
  store().query(`INSERT INTO review_order (thread_id, tier, updated_at, hold, hold_note, hold_at, hold_by) VALUES (?, 'normal', ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET hold = ?, hold_note = ?, hold_at = ?, hold_by = ?, updated_at = ?`)
    .run(id, at, kind, note, kind ? at : null, kind ? by : null, kind, note, kind ? at : null, kind ? by : null, at);
  touchQueue();
  return id;
}

export function tierOf(v: string | undefined): Tier | undefined {
  if (v === undefined) return undefined;
  if (!TIERS.includes(v as Tier)) throw new DakError("bad_tier", `A tier is urgent, normal or later.`);
  return v as Tier;
}

// Tier first, then the order inside it, then the order rows arrived in.
export function byPriority<T extends { tier?: string | null; rank?: number | null }>(a: T, b: T, tie: (x: T, y: T) => number): number {
  const t = (x: T) => TIERS.indexOf((x.tier ?? "normal") as Tier);
  return t(a) - t(b) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || tie(a, b);
}

const me = () => person(loadConfig());

/* An order the person asked for on a thread: a button they picked, or what they wrote ("can you
   move them lower?"). Applied with --confirmed-by <thread>, the order counts as the person's own,
   so it moves rows they placed by hand. Dak checks that the person really answered: their latest
   message there, after the agent's last question, from the last day. What they wrote is returned
   so the agent's output quotes it; Dak cannot read whether the words asked for this order. */
export function confirmedBy(threadId: string, agent: string): { choice: string; at: string; quoted: boolean } {
  const p = me();
  const t = store().query("SELECT from_name, to_reader FROM threads WHERE id = ?").get(threadId) as { from_name: string; to_reader: string } | null;
  if (!t) throw new DakError("no_thread", `No thread ${threadId}.`, 404);
  if (![t.from_name, t.to_reader].includes(agent) || ![t.from_name, t.to_reader].includes(p)) throw new DakError("not_confirmed", `${threadId} is not between you and ${p}.`, 403);
  const asked = (store().query("SELECT max(id) AS id FROM messages WHERE thread_id = ? AND author = ? AND options IS NOT NULL").get(threadId, agent) as { id: number | null }).id ?? 0;
  const said = store().query(`SELECT m.choice, m.body, m.created_at FROM messages m WHERE m.thread_id = ? AND m.author = ? AND m.id > ?
    AND (m.choice IS NOT NULL OR trim(m.body) != '') AND coalesce(m.extra, '') NOT LIKE '%"reviewing":true%' ORDER BY m.id DESC LIMIT 1`)
    .get(threadId, p, asked) as { choice: string | null; body: string; created_at: string } | null;
  if (!said || Date.now() - Date.parse(said.created_at) > 86_400_000) throw new DakError("not_confirmed", `${p} has not answered on ${threadId} since you last asked there (in the last day).`, 403);
  return said.choice ? { choice: said.choice, at: said.created_at, quoted: false } : { choice: said.body.trim().slice(0, 200), at: said.created_at, quoted: true };
}
const isPerson = (by: string) => by === me();

/* ---------- the merge queue ---------- */

// Merge order for the listed PRs, in this order, within their tier. Refused when it puts a PR
// ahead of the one it waits for. An agent's order skips the rows the person placed by hand.
export function orderQueue(prs: number[], by: string, opts: { tier?: Tier } = {}): { ordered: number[]; kept: number[] } {
  ensurePriority();
  const s = store();
  const rows = new Map((s.query("SELECT pr, after_pr, rank_by, pair_id FROM queue").all() as any[]).map((r) => [r.pr, r]));
  for (const pr of prs) if (!rows.has(pr)) throw new DakError("not_in_queue", `#${pr} is not in the merge queue. Add it with dak queue set ${pr} --state approved.`);
  prs.forEach((pr, i) => {
    const after = rows.get(pr).after_pr;
    const j = prs.indexOf(after);
    if (after && j > i) throw new DakError("order_conflict", `#${pr} waits for #${after} (--after), so #${after} must come first.`);
  });
  const kept: number[] = [], ordered: number[] = [];
  s.transaction(() => prs.forEach((pr, i) => {
    if (!isPerson(by) && isPerson(rows.get(pr).rank_by ?? "")) { kept.push(pr); return; }
    s.query("UPDATE queue SET rank = ?, rank_by = ?, tier = coalesce(?, tier), updated_at = ? WHERE pr = ?").run(i + 1, by, opts.tier ?? null, new Date().toISOString(), pr);
    ordered.push(pr);
  }))();
  return { ordered, kept };
}

export function prioritizeQueue(pr: number, by: string, v: { tier?: Tier; why?: string; rank?: number }) {
  ensurePriority();
  const row = store().query("SELECT rank_by FROM queue WHERE pr = ?").get(pr) as { rank_by: string | null } | null;
  if (!row) throw new DakError("not_in_queue", `#${pr} is not in the merge queue.`);
  if (!isPerson(by) && isPerson(row.rank_by ?? "") && (v.tier || v.rank !== undefined)) {
    throw new DakError("person_ordered", `${me()} placed #${pr} by hand; their order wins. Ask them, or set only --why.`);
  }
  store().query(`UPDATE queue SET tier = coalesce(?, tier), why = coalesce(?, why), rank = coalesce(?, rank),
    rank_by = CASE WHEN ? IS NOT NULL OR ? IS NOT NULL THEN ? ELSE rank_by END, updated_at = ? WHERE pr = ?`)
    .run(v.tier ?? null, v.why ?? null, v.rank ?? null, v.tier ?? null, v.rank ?? null, by, new Date().toISOString(), pr);
}

// Two PRs tested together show as one row and merge together.
export function pairQueue(a: number, b: number | null) {
  ensurePriority();
  const s = store();
  const exists = (p: number) => !!s.query("SELECT 1 FROM queue WHERE pr = ?").get(p);
  if (!exists(a) || (b !== null && !exists(b))) throw new DakError("not_in_queue", "Both PRs must be in the merge queue first.");
  const old = (s.query("SELECT pair_id FROM queue WHERE pr = ?").get(a) as { pair_id: string | null }).pair_id;
  if (old) s.query("UPDATE queue SET pair_id = NULL WHERE pair_id = ?").run(old);
  if (b !== null) s.query("UPDATE queue SET pair_id = ?, updated_at = ? WHERE pr IN (?, ?)").run(`${Math.min(a, b)}+${Math.max(a, b)}`, new Date().toISOString(), a, b);
}

const DONE = new Set(["merged", "migrated", "deployed"]);

// What the merge loop takes next: approved, not held or failed, whatever it waits for already
// merged, and, for a pair, both halves approved. Null when nothing is ready.
export function nextInQueue(rows: { pr: number; state: string; after_pr: number | null; pair_id: string | null; tier?: string | null; rank?: number | null; added_at: string }[]) {
  const byPr = new Map(rows.map((r) => [r.pr, r]));
  const ready = (r: (typeof rows)[number]) => {
    if (r.state !== "approved") return false;
    const after = r.after_pr ? byPr.get(r.after_pr) : null;
    if (after && !DONE.has(after.state)) return false;
    return true;
  };
  for (const r of [...rows].sort((a, b) => byPriority(a, b, (x, y) => x.added_at.localeCompare(y.added_at)))) {
    if (!ready(r)) continue;
    const mates = r.pair_id ? rows.filter((x) => x.pair_id === r.pair_id) : [r];
    if (mates.every(ready)) return mates.map((m) => m.pr);
  }
  return null;
}

// Why a row is not moving, in plain words, from what Dak knows plus what the agent said.
export function waitingReason(r: { pr: number; state: string; after_pr: number | null; pair_id: string | null; waiting?: string | null }, rows: typeof r[]): string | null {
  if (r.waiting) return r.waiting;
  const after = r.after_pr ? rows.find((x) => x.pr === r.after_pr) : null;
  if (r.after_pr && (!after || !DONE.has(after.state))) return `Waiting on #${r.after_pr}${after ? ` (${after.state})` : ""}`;
  const mate = r.pair_id ? rows.find((x) => x.pair_id === r.pair_id && x.pr !== r.pr) : null;
  if (mate && mate.state !== r.state) return `Waiting on its pair #${mate.pr} (${mate.state})`;
  return null;
}

/* ---------- review order ---------- */

export function threadFor(ref: string): string {
  const t = String(ref).trim();
  if (/^t_[0-9a-f]+$/.test(t)) return t;
  const n = Number(t.replace(/^#/, ""));
  const id = Number.isInteger(n) ? threadForPr(n) : null;
  if (!id) throw new DakError("no_thread", `No Dak thread carries PR ${t}. Send it first, or pass the thread id.`);
  return id;
}

export const REVIEW_TYPES = ["pr", "brief", "decision", "tryit"] as const;
export function reviewTypeOf(v: string | undefined) {
  if (v === undefined) return undefined;
  if (!REVIEW_TYPES.includes(v as any)) throw new DakError("bad_type", "A type is pr, brief, decision or tryit. (A doc, spec or mock is a brief; a 'try it' on a live feature is tryit; an update needs --fyi, not a type.)");
  return v;
}

// What the agent knows about the ask: its type and what the answer releases. Anyone may set these.
export function describeReview(ref: string, v: { type?: string; blocks?: string }) {
  if (v.type === undefined && v.blocks === undefined) return;
  ensurePriority();
  const id = threadFor(ref);
  const blocks = v.blocks === undefined ? null : ["", "none"].includes(v.blocks.trim()) ? "" : v.blocks.trim();
  store().query(`INSERT INTO review_order (thread_id, tier, type, blocks, updated_at) VALUES (?, 'normal', ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET type = coalesce(?, type), blocks = CASE WHEN ? IS NULL THEN blocks WHEN ? = '' THEN NULL ELSE ? END, updated_at = ?`)
    .run(id, reviewTypeOf(v.type) ?? null, blocks || null, new Date().toISOString(), reviewTypeOf(v.type) ?? null, blocks, blocks, blocks, new Date().toISOString());
  touchQueue();
}

export function prioritizeReview(ref: string, by: string, v: { tier?: Tier; why?: string; rank?: number }) {
  ensurePriority();
  const id = threadFor(ref);
  const s = store();
  const old = s.query("SELECT * FROM review_order WHERE thread_id = ?").get(id) as any;
  if (old && !isPerson(by) && isPerson(old.rank_by ?? "") && (v.tier || v.rank !== undefined)) {
    throw new DakError("person_ordered", `${me()} placed this review by hand; their order wins.`);
  }
  s.query(`INSERT INTO review_order (thread_id, tier, rank, why, rank_by, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET tier = coalesce(?, tier), rank = coalesce(?, rank), why = coalesce(?, why),
      rank_by = CASE WHEN ? IS NOT NULL OR ? IS NOT NULL THEN ? ELSE rank_by END, updated_at = ?`)
    .run(id, v.tier ?? "normal", v.rank ?? null, v.why ?? null, (v.tier || v.rank !== undefined) ? by : null, new Date().toISOString(),
      v.tier ?? null, v.rank ?? null, v.why ?? null, v.tier ?? null, v.rank ?? null, by, new Date().toISOString());
  touchQueue();
}

export function orderReviews(refs: string[], by: string, opts: { tier?: Tier } = {}): { ordered: string[]; kept: string[] } {
  ensurePriority();
  const ids = refs.map(threadFor);
  const kept: string[] = [], ordered: string[] = [];
  store().transaction(() => ids.forEach((id, i) => {
    const old = store().query("SELECT rank_by FROM review_order WHERE thread_id = ?").get(id) as { rank_by: string | null } | null;
    if (!isPerson(by) && isPerson(old?.rank_by ?? "")) { kept.push(id); return; }
    prioritizeReview(id, by, { rank: i + 1, ...(opts.tier ? { tier: opts.tier } : {}) });
    ordered.push(id);
  }))();
  return { ordered, kept };
}

export type OrderedReview = AwaitingReview & Priority & { type: string; blocks: string | null; hold: Hold | null; back: string | null };
export function reviewsInOrder(reader: string): OrderedReview[] {
  ensurePriority();
  const pr = new Map((store().query("SELECT * FROM review_order").all() as any[]).map((r) => [r.thread_id, r]));
  const typed = new Map([...pr].filter(([, r]) => r.type).map(([id, r]) => [id, r.type as string]));
  return awaitingReview(reader, typed).map((r) => {
    const p = pr.get(r.thread_id);
    return { ...r, tier: (p?.tier ?? "normal") as Tier, rank: p?.rank ?? null, why: p?.why ?? null, rank_by: p?.rank_by ?? null, blocks: p?.blocks ?? null,
      hold: holdOf(r.thread_id, p ?? null), back: parkedBackBy(r.thread_id, p ?? null) };
  // Held rows (being reworked, parked) go below everything else, in their own order.
  }).sort((a, b) => Number(!!a.hold) - Number(!!b.hold) || byPriority(a, b, (x, y) => x.waiting_since.localeCompare(y.waiting_since)));
}

// The page refreshes when the queue's stamp moves; a review reorder must move it too.
function touchQueue() {
  store().exec(`CREATE TABLE IF NOT EXISTS queue_touch (k INTEGER PRIMARY KEY, at TEXT)`);
  store().query("INSERT INTO queue_touch VALUES (1, ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at").run(new Date().toISOString());
}
export function touchStamp(): string {
  store().exec(`CREATE TABLE IF NOT EXISTS queue_touch (k INTEGER PRIMARY KEY, at TEXT)`);
  return (store().query("SELECT at FROM queue_touch WHERE k = 1").get() as { at: string } | null)?.at ?? "";
}

/* The person parks a topic from their list, or unparks it. The sender hears it as an update, which
   never wakes a session, so it stops asking without anyone spending a turn on it. The topic stays
   waiting on the person; it only leaves the count. */
export function park(threadId: string, on: boolean, note: string | null, by: string) {
  const id = setHold(threadId, on ? "parked" : null, on ? note : null, by);
  const words = on ? `Parked for now${note ? `: ${note}` : ""}. It comes back to me when you send a new version or a new question.`
    : "Unparked: it is back on my list.";
  addMessage(id, { author: by, body: words, needs_reply: false, extra: { parked: on } });
  return id;
}
