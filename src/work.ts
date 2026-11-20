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
import { addMessage, createThread, store } from "./store";
import { board } from "./board";
import { DakError } from "./types";
import { findStage, stageForPr, stageForState, stagesFor, stateOf, type PrPoint } from "./stages";

export const KINDS = ["code", "mock", "research", "doc", "email", "note"] as const;
export type WorkKind = (typeof KINDS)[number];
// What a piece counts as, from its stage. "Held" is not one of them: it is a flag a piece in any
// stage can carry, with what it is held on.
export const STATES = ["next", "doing", "ready", "done"] as const;
export type WorkState = (typeof STATES)[number];

export interface WorkItem {
  id: string; // "W-12"
  title: string; kind: WorkKind; owner: string;
  ticket: string | null; // the reference: ENG-142, a Notion link, a brief
  state: WorkState; proof: string | null; blocked: string | null;
  thread_id: string | null; pr: number | null;
  created_by: string; created_at: string; updated_at: string; done_at: string | null;
  bounced: string | null; // what the "ready for you" gate said was missing, last time it refused
  held: boolean; // stuck where it is, on what `blocked` says
  from_board: boolean; // read from an open PR on the Board, not made by hand
  pr_stage: string | null;
  stage: string; // the person's stage it is in ("Code review"); see stages.ts
  stage_since: string; // when it got there: how long it has been stuck
  labels: string[]; // its ticket's labels, for the board's filter
}

export function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS work (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL,
      ticket TEXT, state TEXT NOT NULL, proof TEXT, blocked TEXT, thread_id TEXT, pr INTEGER UNIQUE, created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT, bounced TEXT, from_board INTEGER NOT NULL DEFAULT 0, pr_stage TEXT);
    CREATE INDEX IF NOT EXISTS work_by_owner ON work (owner, state);`);
  const cols = new Set((store().query("PRAGMA table_info(work)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("stage")) store().exec("ALTER TABLE work ADD COLUMN stage TEXT; ALTER TABLE work ADD COLUMN stage_since TEXT;");
  // Held used to be a state of its own; it is a flag now, and the piece counts as its stage does.
  if (!cols.has("held")) {
    store().exec("ALTER TABLE work ADD COLUMN held INTEGER NOT NULL DEFAULT 0");
    for (const r of store().query("SELECT id, kind, stage FROM work WHERE state = 'held'").all() as { id: number; kind: string; stage: string | null }[]) {
      const st = stagesFor(r.kind).find((x) => x.name === r.stage);
      store().query("UPDATE work SET held = 1, state = ? WHERE id = ?").run(st ? stateOf(st.gate) : "doing", r.id);
    }
  }
}

// Its ticket's labels, from the Board's copy of Linear; none when there is no Board.
function labelsByTicket(): Map<string, string[]> {
  try { return new Map((store().query("SELECT id, labels FROM tasks").all() as { id: string; labels: string }[]).map((r) => [r.id, JSON.parse(r.labels || "[]")])); }
  catch { return new Map(); }
}

// A piece made before stages stands at the first stage that counts as its state.
const row = (r: any, labels?: Map<string, string[]>): WorkItem => ({ ...r, id: `W-${r.id}`, from_board: !!r.from_board, held: !!r.held,
  stage: r.stage ?? (r.from_board ? stageForPr("pr_open") ?? stageForState(r.kind, r.state) : stageForState(r.kind, r.state)), stage_since: r.stage_since ?? r.updated_at, labels: (r.ticket && labels?.get(r.ticket)) || [] });
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
  // A piece can wait with no owner (made from a Linear issue, say) until it is assigned.
  const owner = input.owner?.trim().toLowerCase() ?? "";
  const state = (input.state ?? "next") as WorkState;
  if (state !== "next" && state !== "doing") throw new DakError("bad_state", "New work starts as next or doing.");
  const t = now();
  const id = store().query(`INSERT INTO work (title, kind, owner, ticket, state, thread_id, created_by, created_at, updated_at, stage, stage_since) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(title, kind, owner, input.ticket?.trim() || null, state, input.thread_id ?? null, input.by, t, t, stageForState(kind, state), t).lastInsertRowid;
  return getWork(`W-${id}`);
}

/* Moving a piece. The rules are here, not in any agent's prompt, so no agent can skip them. */
export function moveWork(id: string, to: string, by: string, opts: { proof?: string | null; blocked?: string | null; thread_id?: string | null; stage?: string } = {}): WorkItem {
  const w = getWork(id);
  const me = person(loadConfig());
  // Only its owner or the person moves a piece; a manager reassigns it rather than finishing it.
  if (by !== w.owner && by !== me) throw new DakError("not_owner", `${w.id} is ${w.owner}'s. Only ${w.owner} or ${me} moves it.`, 403);
  // Holding a piece flags it where it is; moving it anywhere lifts the hold.
  if (to === "held" || to === "unheld") {
    store().query("UPDATE work SET held = ?, blocked = ?, updated_at = ? WHERE id = ?").run(to === "held" ? 1 : 0, to === "held" ? (opts.blocked?.trim() || w.blocked) : null, now(), num(id));
    return getWork(id);
  }
  const state = to as WorkState;
  if (!STATES.includes(state)) throw new DakError("bad_state", `A piece of work is ${STATES.join(", ")}.`);
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
  store().query(`UPDATE work SET state = ?, proof = ?, thread_id = ?, blocked = NULL, held = 0, bounced = CASE WHEN ? = 'ready' THEN NULL ELSE bounced END,
      updated_at = ?, done_at = CASE WHEN ? = 'done' THEN ? ELSE NULL END WHERE id = ?`)
    .run(state, proof ?? null, thread ?? null, state, now(), state, now(), num(id));
  // The stage follows: kept when it already counts as the new state, else the first that does.
  const stage = opts.stage ?? (stateOf(findStage(w.kind, w.stage).stage.gate) === state ? w.stage : stageForState(w.kind, state));
  if (stage !== w.stage) store().query("UPDATE work SET stage = ?, stage_since = ? WHERE id = ?").run(stage, now(), num(id));
  return getWork(id);
}

/* Moving a piece to one of the person's stages. The state it counts as goes through moveWork,
   so the rules hold: entering the person's review needs proof and a briefing topic, the last
   stage needs proof. And only the person moves a piece on from their review. */
export function moveStage(id: string, name: string, by: string, opts: { proof?: string | null; thread_id?: string | null } = {}): WorkItem {
  const w = getWork(id);
  const { stage, index } = findStage(w.kind, name);
  const me = person(loadConfig());
  const cur = findStage(w.kind, w.stage);
  if (cur.stage.gate === "review" && index > cur.index && by !== me) throw new DakError("not_approved", `${w.id} is in ${me}'s review. Only ${me} moves it on.`, 403);
  return moveWork(id, stateOf(stage.gate), by, { ...opts, stage: stage.name });
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
// Where a PR's stage puts its piece among the person's stages, when they tied one to it.
const PR_POINT: Record<string, PrPoint> = { building: "pr_open", fixing: "pr_open", changes: "pr_open", proof: "pr_proof", cursor: "pr_cursor",
  review: "pr_review", approved: "pr_merging", merging: "pr_merging" };
const PR_STATE: Record<string, WorkState> = { building: "doing", cursor: "doing", fixing: "doing", changes: "doing", proof: "doing",
  review: "ready", approved: "ready", merging: "ready" };
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
      const pin = PR_POINT[p.stage] ? stageForPr(PR_POINT[p.stage]) : null;
      const state = pin ? stateOf(stagesFor("code").find((x) => x.name === pin)!.gate) : PR_STATE[p.stage] ?? "doing";
      const held = p.stage === "held" || p.stage === "blocked" ? 1 : 0; // a held PR keeps its stage, flagged
      const had = store().query("SELECT id, state FROM work WHERE pr = ?").get(p.number) as { id: number; state: string } | null;
      // A held or blocked PR has an open PR all the same: it is at least in implementation.
      const stage = pin ?? stageForPr("pr_open") ?? stageForState("code", state);
      if (!had) store().query(`INSERT INTO work (title, kind, owner, ticket, state, thread_id, pr, created_by, created_at, updated_at, from_board, pr_stage, stage, stage_since)
          VALUES (?, 'code', ?, ?, ?, ?, ?, 'board', ?, ?, 1, ?, ?, ?)`).run(p.title, c.agent, c.id, state, p.thread || null, p.number, t, t, p.stage, stage, t);
      else if (had.state !== "done") store().query("UPDATE work SET title = ?, owner = ?, ticket = ?, state = ?, thread_id = coalesce(?, thread_id), pr_stage = ?, updated_at = CASE WHEN state != ? THEN ? ELSE updated_at END WHERE id = ?")
        .run(p.title, c.agent, c.id, state, p.thread || null, p.stage, state, t, had.id);
      store().query("UPDATE work SET held = ? WHERE pr = ? AND state != 'done'").run(held, p.number);
      if (had && had.state !== "done" && pin) store().query("UPDATE work SET stage = ?, stage_since = CASE WHEN stage IS ? THEN stage_since ELSE ? END WHERE id = ?").run(pin, pin, t, had.id);
    }
  }
  // A PR that left the Board (merged, closed) is merged: its proof is the merge. When the person
  // has a stage after Merged (Verified), it waits there for that; otherwise it is done.
  const merged = stageForPr("pr_merged");
  for (const r of store().query("SELECT id, pr, stage FROM work WHERE from_board = 1 AND state != 'done'").all() as { id: number; pr: number; stage: string | null }[]) {
    if (live.has(r.pr)) continue;
    if (merged) { if (r.stage !== merged) store().query("UPDATE work SET state = 'doing', stage = ?, stage_since = ?, proof = coalesce(proof, 'merged'), updated_at = ? WHERE id = ?").run(merged, t, t, r.id); }
    else store().query("UPDATE work SET state = 'done', proof = coalesce(proof, 'merged'), done_at = ?, updated_at = ? WHERE id = ?").run(t, t, r.id);
  }
}

export function listWork(opts: { owner?: string; open?: boolean } = {}): WorkItem[] {
  ensure();
  syncFromBoard();
  const labels = labelsByTicket();
  const where = [opts.owner ? "owner = $o" : "", opts.open ? "(state != 'done' OR done_at > $day)" : ""].filter(Boolean).join(" AND ");
  return (store().query(`SELECT * FROM work ${where ? `WHERE ${where}` : ""} ORDER BY owner, CASE state WHEN 'doing' THEN 0 WHEN 'ready' THEN 1 WHEN 'next' THEN 2 ELSE 3 END, id`)
    .all({ $o: opts.owner ?? "", $day: new Date(Date.now() - 86_400_000).toISOString() }) as any[]).map((r) => row(r, labels));
}

// "No work, no start": an agent Dak would start on its own must have a piece to start from.
export function hasOpenWork(agent: string): boolean {
  ensure();
  if (store().query("SELECT 1 FROM work WHERE owner = ? AND state IN ('next', 'doing') LIMIT 1").get(agent)) return true;
  // A ticket in its Board pile counts: its first PR becomes its first piece.
  try { return !!store().query("SELECT 1 FROM task_assignments WHERE agent = ? LIMIT 1").get(agent); } catch { return false; }
}

/* A piece with no topic yet gets one: the person (or its owner) opens it with the other, about
   the piece, and the piece is linked to it, so its talk, proof and briefing have one home. */
export function startTopic(id: string, by: string): { thread_id: string } {
  const w = getWork(id);
  const me = person(loadConfig());
  if (by !== me && by !== w.owner) throw new DakError("not_owner", `Only ${w.owner} or ${me} starts ${w.id}'s topic.`, 403);
  if (w.thread_id) return { thread_id: w.thread_id };
  const other = by === w.owner ? me : w.owner;
  const { thread } = createThread({ to: other, from: by, subject: `${w.id}: ${w.title}`, kind: "note",
    body: `About ${w.id}: ${w.title}${w.ticket ? ` (${w.ticket})` : ""}.`, attachments: [], needs_reply: false });
  store().query("UPDATE work SET thread_id = ?, updated_at = ? WHERE id = ?").run(thread.id, now(), num(w.id));
  return { thread_id: thread.id };
}

/* Assigning a piece, the way you would give it to a person: the owner changes, and the agent is
   told on the piece's topic (or a new one about it), so it is woken and starts from the piece.
   Only the person assigns; an agent hands its own piece on with dak work give. */
export function assignWork(id: string, owner: string, by: string): WorkItem {
  const w = getWork(id);
  const me = person(loadConfig());
  if (by !== me) throw new DakError("not_yours", `Only ${me} assigns work.`, 403);
  const o = owner.trim().toLowerCase();
  if (!o || o === me) throw new DakError("no_owner", "Assign it to an agent on the team.");
  if (w.from_board) throw new DakError("from_pr", `${w.id} follows its PR; its owner is the PR's engineer.`, 409);
  store().query("UPDATE work SET owner = ?, updated_at = ? WHERE id = ?").run(o, now(), num(w.id));
  const note = `@${o} you're on ${w.id}: ${w.title.replace(/[.\s]+$/, "")}${w.ticket ? ` (${w.ticket})` : ""}. Move it with dak work stage as you go.`;
  if (w.thread_id) addMessage(w.thread_id, { author: me, body: note });
  else {
    const { thread } = createThread({ to: o, from: me, subject: `${w.id}: ${w.title}`, kind: "note", body: note, attachments: [] });
    store().query("UPDATE work SET thread_id = ? WHERE id = ?").run(thread.id, num(w.id));
  }
  return getWork(id);
}
