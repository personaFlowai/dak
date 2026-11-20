/* From Linear: the issues Dak's copy of Linear holds that are not a piece of work yet, so the
   person can make work from any of them. Made work starts in Not started, with no owner, and the
   issue as its ticket; once it is work, the issue leaves this list. Done and cancelled issues are
   left out: there is nothing to do. */
import { loadConfig, person } from "./config";
import { store } from "./store";
import { addWork, ensure as ensureWork, type WorkItem } from "./work";
import { DakError } from "./types";

export interface Issue { id: string; title: string; state: string | null; milestone: string | null; labels: string[]; url: string | null; priority: number | null }

export function openIssues(): Issue[] {
  let rows: any[];
  ensureWork();
  try {
    rows = store().query(`SELECT id, title, state, milestone, labels, url, priority FROM tasks
      WHERE coalesce(state_type, '') NOT IN ('completed', 'canceled')
        AND id NOT IN (SELECT ticket FROM work WHERE ticket IS NOT NULL)
      ORDER BY milestone IS NULL, milestone, CASE state_type WHEN 'started' THEN 0 WHEN 'unstarted' THEN 1 ELSE 2 END, id`).all() as any[];
  } catch { return []; } // no Board copy of Linear yet
  return rows.map((r) => ({ ...r, labels: JSON.parse(r.labels || "[]") }));
}

export function workFromIssue(id: string, by: string, kind = "code"): WorkItem {
  const me = person(loadConfig());
  if (by !== me) throw new DakError("not_yours", `Only ${me} makes work from Linear.`, 403);
  const issue = store().query("SELECT id, title FROM tasks WHERE id = ?").get(id) as { id: string; title: string } | null;
  if (!issue) throw new DakError("no_issue", `Dak has no Linear issue ${id}. Sync Linear first.`, 404);
  if (store().query("SELECT 1 FROM work WHERE ticket = ?").get(id)) throw new DakError("already_work", `${id} is already a piece of work.`, 409);
  return addWork({ title: issue.title, kind, owner: "", ticket: issue.id, by });
}
