/* Work: every piece of work has one owner and one state, and every agent starts from one.

   A ticket (Linear, a brief, a Notion page) is the reference, not the work: one ticket can hold
   ten pieces of work for ten PRs. A piece is code, a mock, research, a doc, an email or a note.
   Code pieces are read from the Board (one per open PR of an assigned ticket); the rest are made
   with `dak work add`. Dak holds the rules a piece moves by:
     - done needs proof: a piece is not done without saying what proves it;
     - nothing reaches the person half-ready: "ready for you" needs proof and the topic that
       briefs it, or Dak sends it back to its owner with what is missing;
     - only the person approves: an agent cannot mark another agent's piece done, and approval
       stays the person's verdict on the topic. */
import { loadConfig, person } from "./config";
import { store } from "./store";
import { board } from "./board";
import { DakError } from "./types";

export const KINDS = ["code", "mock", "research", "doc", "email", "note"] as const;
export type WorkKind = (typeof KINDS)[number];
export const STATES = ["next", "doing", "ready", "held", "done"] as const;
export type WorkState = (typeof STATES)[number];

export interface WorkItem {
  id: string; // "W-12"
  title: string; kind: WorkKind; owner: string;
  ticket: string | null; // the reference: ENG-142, a Notion link, a brief
  state: WorkState; proof: string | null; blocked: string | null;
  thread_id: string | null; pr: number | null;
  created_by: string; created_at: string; updated_at: string; done_at: string | null;
  bounced: string | null; // what the "ready for you" gate said was missing, last time it refused
  from_board: boolean; // read from an open PR on the Board, not made by hand
  pr_stage: string | null;
}

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS work (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL,
      ticket TEXT, state TEXT NOT NULL, proof TEXT, blocked TEXT, thread_id TEXT, pr INTEGER UNIQUE, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT, bounced TEXT, from_board INTEGER NOT NULL DEFAULT 0, pr_stage TEXT);
    CREATE INDEX IF NOT EXISTS work_by_owner ON work (owner, state);`);
}

const row = (r: any): WorkItem => ({ ...r, id: `W-${r.id}`, from_board: !!r.from_board });
const num = (id: string) => {
  const n = Number(String(id).replace(/^W-/i, ""));
  if (!Number.isInteger(n) || n < 1) throw new DakError("bad_work", `"${id}" is not a piece of work. They look like W-12.`);
  return n;
};
const now = () => new Date().toISOString();

export function getWork(id: string): WorkItem {
  ensure();
  const r = store().query("SELECT * FROM work WHERE id = ?").get(num(id));
  if (!r) throw new DakError("no_work", `There is no ${id}.`, 404);
  return row(r);
}

export function addWork(input: { title: string; kind?: string; owner: string; ticket?: string | null; by: string; thread_id?: string | null; state?: string }): WorkItem {
  ensure();
  const title = input.title?.trim();
  if (!title) throw new DakError("no_title", 'Say what the work is: dak work add "Mock the You page" --kind mock --owner dak');
  const kind = (input.kind ?? "note").toLowerCase();
  if (!KINDS.includes(kind as WorkKind)) throw new DakError("bad_kind", `Kind is one of ${KINDS.join(", ")}.`);
  const owner = input.owner?.trim().toLowerCase();
  if (!owner) throw new DakError("no_owner", "Every piece of work has an owner: --owner <agent>.");
  const state = (input.state ?? "next") as WorkState;
  if (state !== "next" && state !== "doing") throw new DakError("bad_state", "New work starts as next or doing.");
  const t = now();
  const id = store().query(`INSERT INTO work (title, kind, owner, ticket, state, thread_id, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(title, kind, owner, input.ticket?.trim() || null, state, input.thread_id ?? null, input.by, t, t).lastInsertRowid;
  return getWork(`W-${id}`);
}

/* Moving a piece. The rules are here, not in any agent's prompt, so no agent can skip them. */
export function moveWork(id: string, to: string, by: string, opts: { proof?: string | null; blocked?: string | null; thread_id?: string | null } = {}): WorkItem {
  const w = getWork(id);
  const state = to as WorkState;
  if (!STATES.includes(state)) throw new DakError("bad_state", `A piece of work is ${STATES.join(", ")}.`);
  const me = person(loadConfig());
  // Only its owner or the person moves a piece; a manager reassigns it rather than finishing it.
  if (by !== w.owner && by !== me) throw new DakError("not_owner", `${w.id} is ${w.owner}'s. Only ${w.owner} or ${me} moves it.`, 403);
  const proof = opts.proof?.trim() || w.proof;
  const thread = opts.thread_id?.trim() || w.thread_id;
  if (state === "done" && !proof) throw new DakError("needs_proof", `${w.id} is not done without proof. Say what proves it: --proof "41 tests pass, journey run on the seed".`);
  if (state === "ready") {
    const missing = [!proof && "proof", !thread && "a topic that briefs it"].filter(Boolean) as string[];
    if (missing.length && by !== me) {
      const why = `missing ${missing.join(" and ")}`;
      store().query("UPDATE work SET bounced = ?, updated_at = ? WHERE id = ?").run(why, now(), num(id));
      const how = [!proof && '--proof "what proves it"', !thread && "--topic t_…"].filter(Boolean).join(" ");
      throw new DakError("not_ready", `${w.id} did not go to ${me}: ${why}. It stays with ${w.owner}. Add ${how}.`, 409);
    }
  }
  store().query(`UPDATE work SET state = ?, proof = ?, thread_id = ?, blocked = ?, bounced = CASE WHEN ? = 'ready' THEN NULL ELSE bounced END,
      updated_at = ?, done_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END WHERE id = ?`)
    .run(state, proof ?? null, thread ?? null, state === "held" ? (opts.blocked?.trim() || w.blocked) : null, state, now(), state, now(), num(id));
  return getWork(id);
}

export function reassignWork(id: string, owner: string, by: string): WorkItem {
  const w = getWork(id);
  const o = owner.trim().toLowerCase();
  if (!o) throw new DakError("no_owner", "Who takes it? dak work give W-12 <agent>");
  store().query("UPDATE work SET owner = ?, updated_at = ? WHERE id = ?").run(o, now(), num(w.id));
  return getWork(id);
}

/* Code pieces come from the Board: each open PR of an assigned ticket is one piece, owned by the
   ticket's engineer. Its state follows the PR's stage; proof and topic come from the PR's thread. */
const PR_STATE: Record<string, WorkState> = { building: "doing", cursor: "doing", fixing: "doing", changes: "doing", proof: "doing",
  review: "ready", approved: "ready", merging: "ready", held: "held", blocked: "held" };
function syncFromBoard() {
  let cards: ReturnType<typeof board>["cards"];
  try { cards = board().cards; } catch { return; }
  const t = now();
  const live = new Set<number>();
  for (const c of cards) {
    if (!c.agent) continue;
    for (const p of c.prs) {
      if (!p.number) continue;
      live.add(p.number);
      const state = PR_STATE[p.stage] ?? "doing";
      const had = store().query("SELECT id, state FROM work WHERE pr = ?").get(p.number) as { id: number; state: string } | null;
      if (!had) store().query(`INSERT INTO work (title, kind, owner, ticket, state, thread_id, pr, created_by, created_at, updated_at, from_board, pr_stage)
          VALUES (?, 'code', ?, ?, ?, ?, ?, 'board', ?, ?, 1, ?)`).run(p.title, c.agent, c.id, state, p.thread || null, p.number, t, t, p.stage);
      else if (had.state !== "done") store().query("UPDATE work SET title = ?, owner = ?, ticket = ?, state = ?, thread_id = coalesce(?, thread_id), pr_stage = ?, updated_at = CASE WHEN state != ? THEN ? ELSE updated_at END WHERE id = ?")
        .run(p.title, c.agent, c.id, state, p.thread || null, p.stage, state, t, had.id);
    }
  }
  // A PR that left the Board (merged, closed) is done: its proof is the merge.
  for (const r of store().query("SELECT id, pr FROM work WHERE from_board = 1 AND state != 'done'").all() as { id: number; pr: number }[])
    if (!live.has(r.pr)) store().query("UPDATE work SET state = 'done', proof = coalesce(proof, 'merged'), done_at = ?, updated_at = ? WHERE id = ?").run(t, t, r.id);
}

export function listWork(opts: { owner?: string; open?: boolean } = {}): WorkItem[] {
  ensure();
  syncFromBoard();
  const where = [opts.owner ? "owner = $o" : "", opts.open ? "(state != 'done' OR done_at > $day)" : ""].filter(Boolean).join(" AND ");
  return (store().query(`SELECT * FROM work ${where ? `WHERE ${where}` : ""} ORDER BY owner, CASE state WHEN 'doing' THEN 0 WHEN 'ready' THEN 1 WHEN 'held' THEN 2 WHEN 'next' THEN 3 ELSE 4 END, id`)
    .all({ $o: opts.owner ?? "", $day: new Date(Date.now() - 86_400_000).toISOString() }) as any[]).map(row);
}

// "No work, no start": an agent Dak would start on its own must have a piece to start from.
export function hasOpenWork(agent: string): boolean {
  ensure();
  if (store().query("SELECT 1 FROM work WHERE owner = ? AND state IN ('next', 'doing', 'held') LIMIT 1").get(agent)) return true;
  // A ticket in its Board pile counts: its first PR becomes its first piece.
  try { return !!store().query("SELECT 1 FROM task_assignments WHERE agent = ? LIMIT 1").get(agent); } catch { return false; }
}
