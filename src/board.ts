/* The Board: the person's backlog, each engineer's pile, and where every ticket stands.

   Linear stays the backlog (tickets, labels, milestones, its own status); src/linear.ts copies
   open tickets here. Dak holds what Linear cannot: which agent has a ticket, the order of each
   agent's pile, the one ticket each agent is on Now, and progress read from the work itself. A
   ticket's stage comes from Dak's own facts (the person's verdicts on the ticket's own topics, the
   merge queue, what the engineer said it is blocked on); Linear only takes a finished ticket off. */
import { loadConfig, person } from "./config";
import { store, createThread, getThread, addMessage } from "./store";
import { queue } from "./queue";
import { prStates } from "./verdicts";
import { team } from "./team";
import { DakError, type Thread } from "./types";

export interface Task {
  id: string; // "REVA-3041" for a Linear ticket, "T-<n>" for one made in Dak
  source: "linear" | "dak";
  title: string; url: string | null;
  labels: string[]; milestone: string | null; project: string | null; team: string | null;
  state: string | null; // Linear's own status name: "Todo", "In Progress", "Checking", "Done"
  state_type: string | null; // backlog, unstarted, started, completed, canceled
  priority: number | null; // Linear: 0 none, 1 urgent ... 4 low
  updated_at: string | null;
}
// next: in a pile, not started. you: its own topic waits on the person, or it is blocked on them.
// blocked: the engineer said what blocks it. review / changes / approved / merging: its own PRs.
// checking: merged and live, but its Done-only-when test is not proven yet (Linear says when).
export type Stage = "backlog" | "next" | "you" | "blocked" | "review" | "changes" | "approved" | "merging" | "checking" | "done";
export interface Work { kind: "pr" | "doc" | "note"; thread: string; label: string; state: string; at: string }
export interface Card extends Task {
  agent: string | null; position: number | null; assigned_at: string | null; started_at: string | null;
  now: boolean; // the one ticket its engineer is on now
  last_word: string | null; // when the engineer last said anything about it (taking it, a status line)
  stage: Stage; stage_note: string | null; // "Cursor round 2", "stopped at: typecheck"
  status: { note: string; blocked: string | null; by: string; at: string } | null; // the engineer's last word
  work: Work[];
  needs_you: boolean;
  history: { at: string; what: string }[]; // assigned, started, the engineer's lines, newest last
}

export const STAGES: Stage[] = ["backlog", "next", "you", "blocked", "review", "changes", "approved", "merging", "checking", "done"];

function ensure() {
  store().exec(`
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT, labels TEXT NOT NULL DEFAULT '[]',
      milestone TEXT, project TEXT, team TEXT, state TEXT, state_type TEXT, priority INTEGER, updated_at TEXT, synced_at TEXT);
    CREATE TABLE IF NOT EXISTS task_assignments (task_id TEXT PRIMARY KEY, agent TEXT NOT NULL, position REAL NOT NULL,
      assigned_at TEXT NOT NULL, assigned_by TEXT NOT NULL, started_at TEXT);
    CREATE TABLE IF NOT EXISTS task_status (task_id TEXT NOT NULL, agent TEXT NOT NULL, note TEXT NOT NULL, blocked TEXT, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS task_status_by_task ON task_status (task_id, at);`);
  const cols = new Set((store().query("PRAGMA table_info(task_assignments)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("now_at")) store().exec("ALTER TABLE task_assignments ADD COLUMN now_at TEXT"); // when it became its engineer's Now
}

// One Now per agent: making a ticket Now puts the agent's previous Now back in its pile.
function makeNow(agent: string, taskId: string | null) {
  store().query("UPDATE task_assignments SET now_at = NULL WHERE agent = ? AND now_at IS NOT NULL AND task_id != coalesce(?, '')").run(agent, taskId);
  if (taskId) store().query("UPDATE task_assignments SET now_at = coalesce(now_at, ?), started_at = coalesce(started_at, ?) WHERE task_id = ? AND agent = ?")
    .run(new Date().toISOString(), new Date().toISOString(), taskId, agent);
}

const rowToTask = (r: any): Task => ({ id: r.id, source: r.source, title: r.title, url: r.url, labels: JSON.parse(r.labels || "[]"), milestone: r.milestone,
  project: r.project, team: r.team, state: r.state, state_type: r.state_type, priority: r.priority, updated_at: r.updated_at });

/* ---------- the backlog itself ---------- */

// Write what Linear (or a person) says a ticket is. Assignments and status lines are Dak's and stay.
export function upsertTasks(list: Task[], syncedAt = new Date().toISOString()) {
  ensure();
  const q = store().query(`INSERT INTO tasks (id, source, title, url, labels, milestone, project, team, state, state_type, priority, updated_at, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, url=excluded.url, labels=excluded.labels, milestone=excluded.milestone,
    project=excluded.project, team=excluded.team, state=excluded.state, state_type=excluded.state_type, priority=excluded.priority, updated_at=excluded.updated_at, synced_at=excluded.synced_at`);
  store().transaction(() => { for (const t of list) q.run(t.id, t.source, t.title, t.url, JSON.stringify(t.labels ?? []), t.milestone, t.project, t.team, t.state, t.state_type, t.priority, t.updated_at, syncedAt); })();
}

// A ticket made in Dak, for work that has no Linear ticket.
export function addTask(title: string, opts: { labels?: string[]; milestone?: string } = {}): Task {
  ensure();
  const n = ((store().query("SELECT count(*) AS n FROM tasks WHERE source = 'dak'").get() as { n: number }).n) + 1;
  const t: Task = { id: `T-${n}`, source: "dak", title: title.trim().slice(0, 200), url: null, labels: opts.labels ?? [], milestone: opts.milestone ?? null,
    project: null, team: null, state: "Todo", state_type: "unstarted", priority: null, updated_at: new Date().toISOString() };
  if (!t.title) throw new DakError("no_title", "Say what the task is.");
  upsertTasks([t]);
  return t;
}

export function getTask(id: string): Task {
  ensure();
  const r = store().query("SELECT * FROM tasks WHERE id = ? COLLATE NOCASE").get(id.trim());
  if (!r) throw new DakError("no_task", `No ticket ${id} on the Board. Linear tickets arrive once the Linear key is set.`, 404);
  return rowToTask(r);
}

/* ---------- assigning, ordering, starting ---------- */

// Put a ticket in an agent's pile (or back in the backlog with agent null), before another one
// or at the end. The agent gets a Dak message saying so; Atlas, when there is one, an FYI.
export function assign(taskId: string, agent: string | null, opts: { before?: string | null; by?: string; quiet?: boolean } = {}): Card {
  place(taskId, agent, opts);
  return card(getTask(taskId).id);
}

// The assignment itself, without reading the card back (which reads every topic): what a bulk
// run of hundreds calls.
function place(taskId: string, agent: string | null, opts: { before?: string | null; by?: string; quiet?: boolean; checked?: boolean } = {}) {
  ensure();
  const task = getTask(taskId);
  const by = opts.by ?? person(loadConfig());
  const prev = store().query("SELECT agent FROM task_assignments WHERE task_id = ?").get(task.id) as { agent: string } | null;
  if (!agent) {
    store().query("DELETE FROM task_assignments WHERE task_id = ?").run(task.id);
    return;
  }
  const who = agent.trim().toLowerCase();
  if (!opts.checked && !team({ all: true }).some((m) => m.name === who && m.kind !== "person")) throw new DakError("no_member", `No agent called ${who} on the team.`, 404);
  const pile = store().query("SELECT task_id, position FROM task_assignments WHERE agent = ? AND task_id != ? ORDER BY position").all(who, task.id) as { task_id: string; position: number }[];
  const at = opts.before ? pile.findIndex((p) => p.task_id.toLowerCase() === opts.before!.toLowerCase()) : -1;
  const position = at < 0 ? (pile.at(-1)?.position ?? 0) + 1 : at === 0 ? pile[0].position - 1 : (pile[at - 1].position + pile[at].position) / 2;
  store().query(`INSERT INTO task_assignments (task_id, agent, position, assigned_at, assigned_by) VALUES (?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET agent = excluded.agent, position = excluded.position,
      assigned_at = CASE WHEN task_assignments.agent = excluded.agent THEN task_assignments.assigned_at ELSE excluded.assigned_at END,
      started_at = CASE WHEN task_assignments.agent = excluded.agent THEN task_assignments.started_at ELSE NULL END`).run(task.id, who, position, new Date().toISOString(), by);
  if (prev?.agent !== who && !opts.quiet) tellAssigned(task, who, by);
}

// Many assignments at once (setting up the Board): each agent gets one message listing what it
// got, in pile order, instead of one per ticket, and the lead one summary. Lines are
// "<ticket> <agent>" (agent "none" puts a ticket back in the backlog); the order of the lines is
// the order of each pile. Every line is checked before anything changes.
export function assignMany(lines: { task: string; agent: string | null }[], by: string, opts: { quiet?: boolean } = {}): { assigned: number; agents: Record<string, number> } {
  ensure();
  const members = new Set(team({ all: true }).filter((m) => m.kind !== "person").map((m) => m.name));
  const bad = lines.flatMap((l, i) => {
    try { getTask(l.task); } catch { return [`line ${i + 1}: no ticket ${l.task}`]; }
    return l.agent && !members.has(l.agent) ? [`line ${i + 1}: no agent ${l.agent}`] : [];
  });
  if (bad.length) throw new DakError("bad_plan", `Nothing was assigned:\n  ${bad.slice(0, 20).join("\n  ")}${bad.length > 20 ? `\n  and ${bad.length - 20} more` : ""}`);
  const got = new Map<string, Task[]>();
  store().transaction(() => {
    for (const l of lines) {
      const before = (store().query("SELECT agent FROM task_assignments WHERE task_id = ?").get(getTask(l.task).id) as { agent: string } | null)?.agent ?? null;
      place(l.task, l.agent, { by, quiet: true, checked: true });
      if (l.agent && before !== l.agent) (got.get(l.agent) ?? got.set(l.agent, []).get(l.agent)!).push(getTask(l.task));
    }
  })();
  if (!opts.quiet) {
    for (const [agent, tasks] of got) {
      const list = tasks.slice(0, 25).map((t, i) => `${i + 1}. ${t.id} ${t.title}`).join("\n");
      onTopic(agent, by, "Board: your pile", `${by} put ${tasks.length} ticket${tasks.length === 1 ? "" : "s"} in your pile:\n\n${list}${tasks.length > 25 ? `\n…and ${tasks.length - 25} more (\`dak pile\`)` : ""}\n\nTake them in order with \`dak next\`; say where you are with \`dak status <ticket> "…"\`.`, false);
    }
    const lead = team({ all: true }).find((m) => m.name === "atlas" && m.kind !== "person");
    if (lead && lead.name !== by && got.size) onTopic(lead.name, by, "Board: assignments", `${by} set up the Board: ${[...got].map(([a, t]) => `${a} ${t.length}`).join(", ")}.`, true);
  }
  return { assigned: lines.length, agents: Object.fromEntries([...got].map(([a, t]) => [a, t.length])) };
}

// One standing topic per agent for its pile, and one for Atlas's FYIs, so assigning ten tickets is
// ten messages on one topic, not ten new topics in everyone's list.
function onTopic(to: string, from: string, subject: string, body: string, quiet: boolean) {
  const t = store().query("SELECT id FROM threads WHERE to_reader = ? AND from_name = ? AND subject = ? ORDER BY created_at DESC LIMIT 1").get(to, from, subject) as { id: string } | null;
  if (t) addMessage(t.id, { author: from, body, ...(quiet ? { needs_reply: false } : { needs_reply: true }) });
  else createThread({ to, from, kind: "note", subject, attachments: [], body, ...(quiet ? { needs_reply: false } : {}) });
}

function tellAssigned(task: Task, agent: string, by: string) {
  const place = pileOf(agent).findIndex((c) => c.id === task.id) + 1;
  const link = task.url ? `\n${task.url}` : "";
  onTopic(agent, by, "Board: your pile", `You're on ${task.id}: ${task.title}. It's #${place} in your pile.${link}\n\nTake it when it's next: \`dak next\` gives you the top of your pile. Say where you are with \`dak status ${task.id} "what you're doing"\`.`, false);
  // The lead hears about it, unless the lead is the one who assigned it.
  const lead = team({ all: true }).find((m) => m.name === "atlas" && m.kind !== "person");
  if (lead && lead.name !== agent && lead.name !== by) onTopic(lead.name, by, "Board: assignments", `${by} gave ${task.id} (${task.title}) to ${agent}, #${place} in their pile.`, true);
}

// The next ticket in an agent's pile that has not started; taking it marks it started.
export function next(agent: string): Card | null {
  ensure();
  const r = store().query("SELECT task_id FROM task_assignments WHERE agent = ? AND now_at IS NULL AND started_at IS NULL ORDER BY position LIMIT 1").get(agent) as { task_id: string } | null;
  if (!r) return null;
  makeNow(agent, r.task_id);
  return card(r.task_id);
}

// The engineer's one line: what they are doing on a ticket, and what blocks it.
export function setTaskStatus(taskId: string, agent: string, note: string, blocked?: string | null): Card {
  ensure();
  const task = getTask(taskId);
  if (!note.trim()) throw new DakError("no_note", "Say what you are doing: dak status <ticket> \"fixing Cursor round 2\".");
  store().query("INSERT INTO task_status (task_id, agent, note, blocked, at) VALUES (?,?,?,?,?)").run(task.id, agent, note.trim().slice(0, 300), blocked?.trim() || null, new Date().toISOString());
  // A line about a ticket makes it this engineer's Now; a blocked one is not Now: it waits.
  const mine = store().query("SELECT 1 FROM task_assignments WHERE task_id = ? AND agent = ?").get(task.id, agent);
  if (mine && !blocked?.trim()) makeNow(agent, task.id);
  if (mine && blocked?.trim()) store().query("UPDATE task_assignments SET now_at = NULL, started_at = coalesce(started_at, ?) WHERE task_id = ?").run(new Date().toISOString(), task.id);
  return card(task.id);
}

/* ---------- reading the work ---------- */

// The Dak topics about a ticket: any whose subject, or a PR's title on it, names the ticket.
function workFor(ids: string[]): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>();
  if (!ids.length) return out;
  const rows = store().query(`SELECT DISTINCT t.* FROM threads t LEFT JOIN messages m ON m.thread_id = t.id LEFT JOIN attachments a ON a.message_id = m.id
    WHERE t.subject LIKE '%-%' OR a.type = 'pr'`).all() as any[];
  const titles = store().query(`SELECT m.thread_id, json_extract(a.meta, '$.title') AS title FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.type = 'pr'`).all() as { thread_id: string; title: string | null }[];
  const re = (id: string) => new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[-]/g, "\\-")}(?![0-9])`, "i");
  for (const id of ids) {
    const r = re(id);
    const hit = new Set(titles.filter((x) => x.title && r.test(x.title)).map((x) => x.thread_id));
    // Dak's own "Board: ..." topics (an agent's pile, Atlas's FYIs) are about the Board, not work on a ticket.
    const ours = (subject: string) => subject.startsWith("Board: ");
    const list = rows.filter((t) => (r.test(t.subject) || hit.has(t.id)) && !ours(t.subject)).map((t) => ({ id: t.id, to: t.to_reader, from: t.from_name, subject: t.subject, kind: t.kind, status: t.status, created_at: t.created_at, updated_at: t.updated_at }) as Thread);
    out.set(id, [...new Map(list.map((t) => [t.id, t])).values()]);
  }
  return out;
}


// Each PR's stage as its newest topic has it (a PR sent on its own topic and again in a batch).
function latestPrStages(work: Work[]): Stage[] {
  const by = new Map<string, Work>();
  for (const w of work) if (w.kind === "pr") { const k = w.label.split(" ")[0]; const cur = by.get(k); if (!cur || w.at > cur.at) by.set(k, w); }
  return [...by.values()].map((w) => w.state as Stage);
}

const RANK: Record<Stage, number> = { backlog: 0, next: 1, you: 2, blocked: 3, changes: 4, review: 5, approved: 6, merging: 7, checking: 8, done: 9 };

/* A ticket's work is its own: the PRs whose title names it, and the topics whose subject names it.
   It needs the person only when one of ITS OWN topics (the subject names the ticket) waits on them
   with no verdict yet: a batch topic that also carries this ticket's PR is the batch's ask, shown
   on that topic, not on every ticket in it. */
function stageOf(task: Task, a: any, s: any, threads: Thread[], me: string, q: Map<number, any>): { stage: Stage; note: string | null; work: Work[]; needs_you: boolean } {
  const work: Work[] = [];
  let needsYou = false;
  let note: string | null = null;
  const names = new RegExp(`(^|[^A-Za-z0-9])${task.id.replace(/[-]/g, "\\-")}(?![0-9])`, "i");
  for (const t of threads) {
    const full = getThread(t.id);
    const all = prStates(full.messages, [t.to]);
    const own = names.test(t.subject);
    const asksMe = own && t.status === "waiting" && t.to === me;
    if (all.length) {
      const mine = all.filter((p) => names.test(p.title ?? ""));
      const prs = mine.length ? mine : all.length === 1 && own ? all : [];
      for (const p of prs) {
        const row = p.number ? q.get(p.number) : null;
        let st: Stage | "live" = p.verdict === "approve" ? "approved" : p.verdict === "changes" ? "changes" : "review";
        if (row) {
          if (["deployed", "merged", "migrated"].includes(row.state)) st = "live";
          else if (["testing", "building", "merging", "failed", "held"].includes(row.state)) { st = "merging"; if (row.state === "failed" || row.state === "held") note = `stopped: ${row.note ?? row.state}`; }
        }
        if (asksMe && !p.verdict) needsYou = true;
        work.push({ kind: "pr", thread: t.id, label: `${p.key}${p.title ? ` ${p.title}` : ""}`, state: asksMe && !p.verdict ? "you" : st, at: t.updated_at });
      }
    } else if (own) {
      if (asksMe) needsYou = true;
      work.push({ kind: full.messages.some((m) => m.attachments.some((x) => x.type === "doc" || x.type === "file")) ? "doc" : "note", thread: t.id, label: t.subject,
        state: asksMe ? "you" : t.status === "closed" ? "done" : "review", at: t.updated_at });
    }
  }
  const byKey = new Map<string, Work>();
  for (const w of work) { const k = w.kind === "pr" ? w.label.split(" ")[0] : `${w.thread}|${w.label}`; const cur = byKey.get(k); if (!cur || w.at > cur.at) byKey.set(k, w); }
  const unique = [...byKey.values()].sort((x, y) => x.at.localeCompare(y.at));
  const prs = latestPrStages(unique);
  const open = prs.filter((x) => (x as string) !== "live");
  const blocked = s?.blocked as string | null | undefined;
  let stage: Stage;
  if (task.state_type === "completed" || task.state_type === "canceled") stage = "done";
  // Every PR it has is merged and live: it stays on the Board as Checking until Linear says Done,
  // so merged work never vanishes before its test is proven. Linear's own "Checking" says so too.
  else if ((prs.length && !open.length) || /check/i.test(task.state ?? "")) stage = "checking";
  // "Needs you" is only ever something you can open and answer: a topic of the ticket's own that
  // waits on you. An engineer saying it is blocked on you is Blocked, with their reason, until
  // they ask on Dak.
  else if (needsYou) stage = "you";
  else if (blocked) { stage = "blocked"; note = `blocked: ${blocked}`; }
  else if (open.length) stage = open.reduce((lo, x) => (RANK[x] < RANK[lo] ? x : lo));
  else if (a) stage = "next";
  else stage = "backlog";
  if (stage === "done") needsYou = false;
  return { stage, note, work: unique, needs_you: needsYou };
}

function cardsFor(tasks: Task[]): Card[] {
  const me = person(loadConfig());
  const as = new Map((store().query("SELECT * FROM task_assignments").all() as any[]).map((r) => [r.task_id, r]));
  const st = new Map<string, any>();
  const lines = new Map<string, any[]>();
  for (const r of store().query("SELECT * FROM task_status ORDER BY at").all() as any[]) { st.set(r.task_id, r); (lines.get(r.task_id) ?? lines.set(r.task_id, []).get(r.task_id)!).push(r); }
  const q = new Map(queue({ all: true }).map((r) => [r.pr, r]));
  const works = workFor(tasks.map((t) => t.id));
  // An engineer who took tickets before Now existed (or never ran dak next) still has one: the
  // ticket they last said something about that is not blocked. Set explicitly, it wins.
  const implicitNow = new Map<string, { id: string; at: string }>();
  const explicit = new Set([...as.values()].filter((r: any) => r.now_at).map((r: any) => r.agent));
  for (const r of as.values() as any) {
    if (explicit.has(r.agent) || !r.started_at) continue;
    const last = st.get(r.task_id);
    if (last?.blocked) continue;
    const at = [r.started_at, last?.at].filter(Boolean).sort().at(-1)!;
    const cur = implicitNow.get(r.agent);
    if (!cur || at > cur.at) implicitNow.set(r.agent, { id: r.task_id, at });
  }
  return tasks.map((t) => {
    const a = as.get(t.id), s = st.get(t.id);
    const { stage, note, work, needs_you } = stageOf(t, a, s, works.get(t.id) ?? [], me, q);
    const lastWord = [a?.now_at, a?.started_at, s?.at].filter(Boolean).sort().at(-1) ?? null;
    return { ...t, agent: a?.agent ?? null, position: a?.position ?? null, assigned_at: a?.assigned_at ?? null, started_at: a?.started_at ?? null,
      now: (!!a?.now_at || implicitNow.get(a?.agent)?.id === t.id) && stage !== "done" && stage !== "blocked", last_word: lastWord,
      stage, stage_note: note ?? (s && !s.blocked ? s.note : null),
      status: s ? { note: s.note, blocked: s.blocked, by: s.agent, at: s.at } : null, work, needs_you,
      history: [
        ...(a ? [{ at: a.assigned_at, what: `${a.assigned_by} gave it to ${a.agent}` }] : []),
        ...(a?.started_at ? [{ at: a.started_at, what: `${a.agent} started it` }] : []),
        ...(lines.get(t.id) ?? []).slice(-6).map((r) => ({ at: r.at, what: `${r.agent}: ${r.note}${r.blocked ? ` (blocked: ${r.blocked})` : ""}` })),
      ].sort((x, y) => x.at.localeCompare(y.at)) };
  });
}

export function card(id: string): Card { return cardsFor([getTask(id)])[0]; }

export function pileOf(agent: string): Card[] {
  ensure();
  const ids = (store().query("SELECT task_id FROM task_assignments WHERE agent = ? ORDER BY position").all(agent) as { task_id: string }[]).map((r) => r.task_id);
  const tasks = ids.map((id) => store().query("SELECT * FROM tasks WHERE id = ?").get(id)).filter(Boolean).map(rowToTask);
  return cardsFor(tasks);
}

// Everything for the Board page: open tickets, plus what finished in the last few days.
export function board(): { cards: Card[]; labels: string[]; milestones: string[]; synced_at: string | null } {
  ensure();
  const since = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const tasks = (store().query(`SELECT * FROM tasks WHERE coalesce(state_type, '') NOT IN ('completed', 'canceled') OR updated_at > ? OR id IN (SELECT task_id FROM task_assignments)`).all(since) as any[]).map(rowToTask);
  const cards = cardsFor(tasks).filter((c) => c.stage !== "done" || (c.updated_at ?? "") > since);
  const labels = [...new Set(cards.flatMap((c) => c.labels))].sort();
  const milestones = [...new Set(cards.map((c) => c.milestone).filter(Boolean) as string[])].sort();
  const synced = (store().query("SELECT max(synced_at) AS s FROM tasks WHERE source = 'linear'").get() as { s: string | null }).s;
  return { cards, labels, milestones, synced_at: synced };
}
