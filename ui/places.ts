/* The three places release 1 adds: You (what waits on you, most blocking first, and what you
   decided), Work (every piece with its owner, and what is shipping), and Rules (yours, the four
   Dak keeps in code, and what each agent may do). The pages read the same API an agent does. */
import { api } from "./api";
import { S, esc, me, name, mark, when } from "./state";
import { I, ticketMark } from "./icons";
import { stagesEditor } from "./stagesedit";

export interface WorkItem {
  id: string; title: string; kind: string; owner: string; ticket: string | null; state: "next" | "doing" | "ready" | "done"; held: boolean;
  proof: string | null; blocked: string | null; thread_id: string | null; pr: number | null; created_at: string; updated_at: string;
  done_at: string | null; bounced: string | null; from_board: boolean; pr_stage: string | null;
  stage: string; stage_since: string; labels: string[];
}
export interface Decided { thread_id: string; subject: string; asked_by: string; question: string; choice: string; decided_at: string }
export interface RulesData { kept: { key: string; text: string; how: string }[]; rules: { id: number; text: string; by: string; at: string }[];
  permissions: { id: number; agent: string; may: string; by: string; at: string }[] }

export const P = { starting: null as string | null, work: [] as WorkItem[], decided: [] as Decided[], rules: null as RulesData | null, error: "", open: null as string | null,
  parkedOpen: false };

export async function setParked(threadId: string, on: boolean) {
  await api(`/reviews/${encodeURIComponent(threadId)}/park`, { method: "POST", body: { park: on, by: me } });
}

export async function loadWork() { try { P.work = await api<WorkItem[]>("/work"); P.error = ""; } catch (e: any) { P.error = e.message; } }
export async function loadDecided() { try { P.decided = (await api<Decided[]>(`/decisions?for=${encodeURIComponent(me)}`)).slice(0, 12); } catch { /* the record shows empty */ } }
export async function loadRules() { try { P.rules = await api<RulesData>("/rules"); } catch (e: any) { P.error = e.message; } }

const ref = (t: string | null) => t ? `<span class="ref">${ticketMark(t)}${esc(t)}</span>` : "";
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m || 1} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const TYPE: Record<string, string> = { pr: "PR", brief: "Brief", decision: "Decision", tryit: "Try it" };

/* ---------- You ---------- */

export const youCount = () => S.reviews.length + readyAlone().length;
export function youSub(): string {
  const n = youCount();
  return n ? `${n} wait${n === 1 ? "s" : ""} on you, urgent first` : "Nothing waits on you";
}
// Pieces marked ready whose topic is not already on the list.
const readyAlone = () => P.work.filter((w) => w.state === "ready" && !w.from_board && !S.reviews.some((r) => r.thread_id === w.thread_id));

// What the gate checked, for pieces made in Dak. A PR's proof is in its own handoff on the topic,
// so code pieces read from the Board show no checks here rather than a false "no proof".
function checks(all: WorkItem[]): string {
  const pieces = all.filter((w) => !w.from_board);
  if (!pieces.length) return "";
  const proof = pieces.every((w) => w.proof);
  return `<div class="ychecks"><span class="${proof ? "ok" : "miss"}">${proof ? "✓" : "✗"} Proof${proof && pieces.length === 1 && !pieces[0].from_board ? `: ${esc(pieces[0].proof!)}` : ""}</span>
    <span class="ok">✓ Briefed on its topic</span></div>`;
}

// One thing waiting on you. "Urgent" is its one priority; Park is its one hold.
function youRow(r: (typeof S.reviews)[number]): string {
  const pieces = P.work.filter((w) => w.thread_id === r.thread_id && w.state !== "done");
  const piece = pieces[0];
  const answer = r.type === "decision" || r.type === "tryit";
  return `<li class="yrow"><div class="ymain">
      <button class="yq" data-topic="${esc(r.thread_id)}">${r.pr ? `#${r.pr} ` : ""}${esc(r.subject)}</button>
      <div class="ymeta">${r.tier === "urgent" ? `<span class="yurgent">Urgent</span>` : ""}${mark(r.from, "sm")}<span>${esc(name(r.from))}</span>${piece ? `<span>· ${esc(piece.id)}</span>` : ""}${pieces.map((w) => ref(w.ticket)).find(Boolean) ?? ""}
<span>· ${ago(r.waiting_since)}</span>${(r as any).back ? `<span class="back">· back: ${esc((r as any).back)}</span>` : ""}</div>
      ${r.why ? `<div class="ywhy">${esc(r.why)}</div>` : ""}${checks(pieces)}</div>
    <div class="yacts"><button class="btn subtle" data-park="${esc(r.thread_id)}" title="Out of your list until you unpark it, or ${esc(name(r.from))} sends a new version or question">Park</button>
      <button class="btn p" data-topic="${esc(r.thread_id)}">${answer ? "Answer" : "Open"}</button></div></li>`;
}

// What you parked, and what an agent said is being reworked: folded at the bottom, not counted.
function parkedSection(): string {
  const held = S.heldReviews;
  if (!held.length) return "";
  const row = (r: (typeof held)[number]) => `<li class="yrow held"><div class="ymain"><button class="yq" data-topic="${esc(r.thread_id)}">${r.pr ? `#${r.pr} ` : ""}${esc(r.subject)}</button>
      <div class="ymeta">${mark(r.from, "sm")}<span>${esc(name(r.from))}</span><span class="kind">${TYPE[r.type] ?? esc(r.type)}</span>
        <span>· ${r.hold.kind === "parked" ? `parked ${r.hold.by === me ? "by you " : ""}${ago(r.hold.at)}` : "being reworked; back with its next version"}</span></div>
      ${r.hold.note ? `<div class="ywhy">${esc(r.hold.note)}</div>` : ""}</div>
    <div class="yacts">${r.hold.kind === "parked" ? `<button class="btn" data-unpark="${esc(r.thread_id)}">Unpark</button>` : ""}</div></li>`;
  return `<h2>Parked <i>${held.length} · back when it gets a new version or a question</i></h2><ol class="ylist">${held.map(row).join("")}</ol>`;
}

function readyRow(w: WorkItem): string {
  return `<li class="yrow"><div class="ymain"><button class="yq" ${w.thread_id ? `data-topic="${esc(w.thread_id)}"` : ""}>${esc(w.title)}</button>
      <div class="ymeta">${mark(w.owner, "sm")}<span>${esc(name(w.owner))}</span><span>· ${w.id}</span>${ref(w.ticket)}<span>· ${ago(w.stage_since)}</span></div>${checks([w])}</div>
    <div class="yacts">${w.thread_id ? `<button class="btn p" data-topic="${esc(w.thread_id)}">Open</button>` : ""}</div></li>`;
}

/* What waits on you, in two lists: pieces in your review (PRs, briefs, work marked ready), then
   questions an agent asked you with buttons. Urgent first. Parked below, not counted. */
export function youView(): string {
  const urgentFirst = (a: (typeof S.reviews)[number], b: (typeof S.reviews)[number]) => Number(b.tier === "urgent") - Number(a.tier === "urgent");
  const review = S.reviews.filter((r) => r.type !== "decision" && r.type !== "tryit").sort(urgentFirst);
  const asks = S.reviews.filter((r) => r.type === "decision" || r.type === "tryit").sort(urgentFirst);
  const reviewRows = [...review.map(youRow), ...readyAlone().map(readyRow)];
  const bounced = P.work.filter((w) => w.bounced && w.state !== "ready" && w.state !== "done");
  const decided = P.decided.length ? `<div class="ylog">${P.decided.map((d) => `<div><span class="w">${when(d.decided_at)}</span>
      <button class="link" data-topic="${esc(d.thread_id)}">Picked “${esc(d.choice)}” · ${esc(d.subject)}</button></div>`).join("")}</div>` : `<p class="yempty">Nothing decided yet.</p>`;
  return `<div class="pane-body"><div class="r1">
    <h2>Your review <i>${reviewRows.length}</i></h2>
    ${reviewRows.length ? `<ol class="ylist">${reviewRows.join("")}</ol>` : `<p class="yempty">Nothing to review.</p>`}
    ${bounced.length ? `<div class="ygate"><b>Not shown here, by rule:</b> ${bounced.length} piece${bounced.length === 1 ? "" : "s"} marked ready without what your review needs (${[...new Set(bounced.map((w) => w.bounced ?? ""))].map(esc).join("; ")}). They went back to their owners.</div>` : ""}
    <h2>Questions <i>${asks.length}</i></h2>
    ${asks.length ? `<ol class="ylist">${asks.map(youRow).join("")}</ol>` : `<p class="yempty">No questions for you.</p>`}
    ${parkedSection()}
    <h2>You decided <i>searchable by every agent with dak decisions</i></h2>${decided}
  </div></div>`;
}

/* ---------- Work ---------- */

// The Work board lives in workboard.ts.

/* ---------- Rules ---------- */

export function rulesView(): string {
  const r = P.rules;
  if (!r) return `<div class="pane-body"><div class="r1"><p class="yempty">Loading the rules.</p></div></div>`;
  const agents = [...new Set(S.agents.filter((a) => a.kind === "agent").map((a) => a.name))];
  return `<div class="pane-body"><div class="r1">
    <p class="lockline">${I.lock}Only you write this page. Agents read it with <code>dak rules</code>; no agent command changes it.</p>
    <h2>Kept by Dak <i>in code, whichever agent or tool is on the other end</i></h2>
    <div class="rules">${r.kept.map((k) => `<div class="rule"><div><b>${esc(k.text)}</b><div class="why">${esc(k.how)}</div></div><span class="by">${I.shield}Dak</span></div>`).join("")}</div>
    ${stagesEditor()}
    <h2>Your rules <i>${r.rules.length}</i></h2>
    <div class="rules">${r.rules.map((x) => `<div class="rule"><div><b>${esc(x.text)}</b><div class="why">${when(x.at)}</div></div><button class="link danger" data-rule-del="rule:${x.id}">Remove</button></div>`).join("")}
      <form class="rule add" data-rule-form="rule"><input name="text" placeholder="A rule every agent reads, such as “Freeze until open PRs merge”" autocomplete="off"><button class="btn">Add</button></form></div>
    <h2>What each agent may do without asking <i>${r.permissions.length}</i></h2>
    <div class="rules">${r.permissions.map((p) => `<div class="rule"><div class="pagent">${mark(p.agent, "sm")}<b>${esc(name(p.agent))}</b><span>may ${esc(p.may)}</span></div><button class="link danger" data-rule-del="permission:${p.id}">Remove</button></div>`).join("")}
      <form class="rule add" data-rule-form="permission"><select name="agent">${agents.map((a) => `<option value="${esc(a)}">${esc(name(a))}</option>`).join("")}</select>
        <input name="may" placeholder="merge its own PRs after your approval" autocomplete="off"><button class="btn">Add</button></form></div>
  </div></div>`;
}

export async function submitRule(form: HTMLFormElement) {
  const kind = form.dataset.ruleForm!;
  const f = new FormData(form);
  const body = kind === "rule" ? { text: f.get("text"), by: me } : { agent: f.get("agent"), may: f.get("may"), by: me };
  P.rules = await api<RulesData>(`/rules/${kind}`, { method: "POST", body });
}
export async function deleteRule(key: string) {
  const [kind, id] = key.split(":");
  P.rules = await api<RulesData>(`/rules/${kind}/${id}?by=${encodeURIComponent(me)}`, { method: "DELETE" });
}
