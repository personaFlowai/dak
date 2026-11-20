/* Stages: the steps each kind of work goes through, in the person's own words and order. The
   Work board shows one column per stage.

   The person names them; Dak keeps its rules on them. Each stage says which of Dak's states it
   counts as (next, doing, ready for the person, done), so the rules in work.ts hold whatever the
   names: a piece reaches the person's review only with proof and a briefing topic, only the
   person moves it past that review, and the last stage needs proof.

   A code piece moves by itself: each stage can say which point in a PR's life brings it there
   (opened, Cursor running, waiting on the person, merging, merged). */
import { loadConfig, person } from "./config";
import { store } from "./store";
import { DakError } from "./types";

export type Gate = "start" | "work" | "review" | "done";
export const GATES: Gate[] = ["start", "work", "review", "done"];
export const PR_POINTS = ["", "pr_open", "pr_proof", "pr_cursor", "pr_review", "pr_merging", "pr_merged"] as const;
export type PrPoint = (typeof PR_POINTS)[number];
export interface Stage { name: string; gate: Gate; stuck_hours: number | null; pr: PrPoint }

const s = (name: string, gate: Gate, stuck_hours: number | null, pr: PrPoint = ""): Stage => ({ name, gate, stuck_hours, pr });
export const DEFAULTS: Record<string, Stage[]> = {
  code: [s("Not started", "start", 72), s("Planned", "work", 48), s("Implementation", "work", 48, "pr_open"), s("Testing", "work", 24, "pr_proof"),
    s("Code review", "work", 24, "pr_cursor"), s("Your review", "review", 24, "pr_review"), s("Merging", "work", 4, "pr_merging"),
    s("Merged", "work", 24, "pr_merged"), s("Verified", "done", null)],
  mock: [s("Not started", "start", 72), s("Drafting", "work", 48), s("Your review", "review", 24), s("Changes", "work", 24), s("Approved", "done", null)],
  research: [s("Not started", "start", 72), s("Researching", "work", 48), s("Your review", "review", 24), s("Answered", "done", null)],
  doc: [s("Not started", "start", 72), s("Writing", "work", 48), s("Your review", "review", 24), s("Done", "done", null)],
  email: [s("Not started", "start", 72), s("Drafting", "work", 24), s("Your review", "review", 24), s("Sent", "done", null)],
  note: [s("Not started", "start", 72), s("Doing", "work", 48), s("Done", "done", null)],
};

function ensure() {
  store().exec("CREATE TABLE IF NOT EXISTS work_stages (kind TEXT PRIMARY KEY, stages TEXT NOT NULL, updated_at TEXT NOT NULL)");
}

export function stagesFor(kind: string): Stage[] {
  ensure();
  const r = store().query("SELECT stages FROM work_stages WHERE kind = ?").get(kind) as { stages: string } | null;
  return r ? JSON.parse(r.stages) : DEFAULTS[kind] ?? DEFAULTS.note;
}
export const allStages = () => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, stagesFor(k)]));

// The person's list. It must still let a piece start, get reviewed and finish.
export function setStages(kind: string, list: Stage[], by: string): Stage[] {
  const me = person(loadConfig());
  if (by !== me) throw new DakError("not_yours", `Only ${me} sets the stages.`, 403);
  if (!DEFAULTS[kind]) throw new DakError("bad_kind", `Kind is one of ${Object.keys(DEFAULTS).join(", ")}.`);
  const clean = list.map((x) => ({ name: String(x.name ?? "").trim().slice(0, 40), gate: x.gate, stuck_hours: x.stuck_hours ? Math.max(1, Number(x.stuck_hours)) : null,
    pr: (PR_POINTS as readonly string[]).includes(x.pr) ? x.pr : "" })) as Stage[];
  if (clean.some((x) => !x.name)) throw new DakError("bad_stage", "Every stage needs a name.");
  if (new Set(clean.map((x) => x.name.toLowerCase())).size !== clean.length) throw new DakError("bad_stage", "Two stages have the same name.");
  if (clean.some((x) => !GATES.includes(x.gate))) throw new DakError("bad_stage", `A stage counts as one of ${GATES.join(", ")}.`);
  if (clean[0]?.gate !== "start") throw new DakError("bad_stage", "The first stage is where work waits to start.");
  if (clean.at(-1)?.gate !== "done" || clean.filter((x) => x.gate === "done").length !== 1) throw new DakError("bad_stage", "The last stage, and only the last, is done: it needs proof.");
  if (clean.filter((x) => x.gate === "review").length > 1) throw new DakError("bad_stage", "One stage at most is your review.");
  ensure();
  const before = stagesFor(kind);
  store().query("INSERT INTO work_stages VALUES (?,?,?) ON CONFLICT(kind) DO UPDATE SET stages = excluded.stages, updated_at = excluded.updated_at")
    .run(kind, JSON.stringify(clean), new Date().toISOString());
  // A stage renamed or removed takes its pieces to the stage now in its place, so none drops off
  // the board: "Testing" renamed "QA" keeps its pieces.
  for (const [i, old] of before.entries()) {
    if (clean.some((x) => x.name === old.name)) continue;
    const to = clean[Math.min(i, clean.length - 1)].name;
    try { store().query("UPDATE work SET stage = ? WHERE kind = ? AND stage = ?").run(to, kind, old.name); } catch { /* no work yet */ }
  }
  return clean;
}

// Find a stage by name, forgiving case and spaces: "code review", "Code Review", "code-review".
export function findStage(kind: string, name: string): { stage: Stage; index: number } {
  const key = (t: string) => t.toLowerCase().replace(/[\s_-]+/g, "");
  const list = stagesFor(kind);
  const index = list.findIndex((x) => key(x.name) === key(name));
  if (index < 0) throw new DakError("no_stage", `${kind} work has no stage "${name}". Its stages: ${list.map((x) => x.name).join(", ")}.`);
  return { stage: list[index], index };
}

// The state a stage counts as, for Dak's rules.
export const stateOf = (g: Gate) => (g === "start" ? "next" : g === "review" ? "ready" : g === "done" ? "done" : "doing");

// Where an old piece (made before stages) stands: the first stage that counts as its state.
export function stageForState(kind: string, state: string): string {
  const list = stagesFor(kind);
  const want: Gate = state === "next" ? "start" : state === "ready" ? "review" : state === "done" ? "done" : "work";
  return (list.find((x) => x.gate === want) ?? list[0]).name;
}

// The stage a PR's point in life brings a code piece to, if the person tied one to it.
export function stageForPr(point: PrPoint): string | null {
  return stagesFor("code").find((x) => x.pr === point)?.name ?? null;
}
