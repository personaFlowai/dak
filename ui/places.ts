/* The three places release 1 adds: You (what waits on you, most blocking first, and what you
   decided), Work (every piece with its owner, and what is shipping), and Rules (yours, the four
   Dak keeps in code, and what each agent may do). The pages read the same API an agent does. */
import { api } from "./api";
import { S, esc, me, name, mark, when } from "./state";
import { I, ticketMark } from "./icons";

export interface WorkItem {
  id: string; title: string; kind: string; owner: string; ticket: string | null; state: "next" | "doing" | "ready" | "held" | "done";
  proof: string | null; blocked: string | null; thread_id: string | null; pr: number | null; created_at: string; updated_at: string;
  done_at: string | null; bounced: string | null; from_board: boolean; pr_stage: string | null;
}
export interface Decided { thread_id: string; subject: string; asked_by: string; question: string; choice: string; decided_at: string }
export interface RulesData { kept: { key: string; text: string; how: string }[]; rules: { id: number; text: string; by: string; at: string }[];
  permissions: { id: number; agent: string; may: string; by: string; at: string }[] }

export const P = { work: [] as WorkItem[], decided: [] as Decided[], rules: null as RulesData | null, error: "", open: null as string | null,
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
  return n ? `${n} wait${n === 1 ? "s" : ""} on you, most blocking first` : "Nothing waits on you";
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

function youRow(r: (typeof S.reviews)[number], i: number): string {
  const pieces = P.work.filter((w) => w.thread_id === r.thread_id && w.state !== "done");
  const holds = r.blocks || (pieces.length ? pieces.map((w) => w.id).join(", ") : "");
  const act = r.type === "decision" || r.type === "tryit" ? `<button class="btn p" data-topic="${esc(r.thread_id)}">Answer</button>`
    : `<button class="btn p" data-topic="${esc(r.thread_id)}">Review</button>${r.reviewing_since ? "" : `<button class="btn" data-reviewing="${esc(r.thread_id)}">I'm on it</button>`}`;
  return `<li class="yrow"><span class="yno">${i + 1}</span><div class="ymain">
      <button class="yq" data-topic="${esc(r.thread_id)}">${r.pr ? `#${r.pr} ` : ""}${esc(r.subject)}</button>
      <div class="ymeta">${mark(r.from, "sm")}<span>${esc(name(r.from))}</span><span class="kind">${TYPE[r.type] ?? esc(r.type)}</span>${pieces.map((w) => ref(w.ticket)).find(Boolean) ?? ""}
<span>· asked ${ago(r.waiting_since)}</span>${r.reviewing_since ? `<span class="on">· you're on it</span>` : ""}${(r as any).back ? `<span class="back">· back: ${esc((r as any).back)}</span>` : ""}</div>
      ${holds ? `<div class="yholds">Holds up <b>${esc(holds)}</b></div>` : ""}${r.why ? `<div class="ywhy">${esc(r.why)}</div>` : ""}${checks(pieces)}</div>
    <div class="yacts">${act}<button class="btn subtle" data-park="${esc(r.thread_id)}" title="Out of your list until you unpark it, or ${esc(name(r.from))} sends a new version or question">Park</button></div></li>`;
}

// What you parked, and what an agent said is being reworked: folded at the bottom, not counted.
function parkedSection(): string {
  const held = S.heldReviews;
  if (!held.length) return "";
  const open = P.parkedOpen;
  const row = (r: (typeof held)[number]) => `<li class="yrow held"><div class="ymain"><button class="yq" data-topic="${esc(r.thread_id)}">${r.pr ? `#${r.pr} ` : ""}${esc(r.subject)}</button>
      <div class="ymeta">${mark(r.from, "sm")}<span>${esc(name(r.from))}</span><span class="kind">${TYPE[r.type] ?? esc(r.type)}</span>
        <span>· ${r.hold.kind === "parked" ? `parked ${r.hold.by === me ? "by you " : ""}${ago(r.hold.at)}` : "being reworked; back with its next version"}</span></div>
      ${r.hold.note ? `<div class="ywhy">${esc(r.hold.note)}</div>` : ""}</div>
    <div class="yacts">${r.hold.kind === "parked" ? `<button class="btn" data-unpark="${esc(r.thread_id)}">Unpark</button>` : ""}</div></li>`;
  return `<button class="yfold" data-parked-fold aria-expanded="${open}">${I.next}<span>Parked</span><i>${held.length} · not counted</i></button>
    ${open ? `<ol class="ylist">${held.map(row).join("")}</ol>` : ""}`;
}

function readyRow(w: WorkItem, i: number): string {
  return `<li class="yrow"><span class="yno">${i}</span><div class="ymain"><button class="yq" ${w.thread_id ? `data-topic="${esc(w.thread_id)}"` : ""}>${esc(w.title)}</button>
      <div class="ymeta">${mark(w.owner, "sm")}<span>${esc(name(w.owner))}</span><span class="kind">${esc(w.kind)}</span>${ref(w.ticket)}<span>${w.id} · ready ${ago(w.updated_at)}</span></div>${checks([w])}</div>
    <div class="yacts">${w.thread_id ? `<button class="btn p" data-topic="${esc(w.thread_id)}">Open</button>` : ""}</div></li>`;
}

export function youView(): string {
  const alone = readyAlone();
  const rows = [...S.reviews.map(youRow), ...alone.map((w, i) => readyRow(w, S.reviews.length + i + 1))];
  const bounced = P.work.filter((w) => w.bounced && w.state !== "ready" && w.state !== "done");
  const decided = P.decided.length ? `<div class="ylog">${P.decided.map((d) => `<div><span class="w">${when(d.decided_at)}</span>
      <button class="link" data-topic="${esc(d.thread_id)}">Picked “${esc(d.choice)}” · ${esc(d.subject)}</button></div>`).join("")}</div>` : `<p class="yempty">Nothing decided yet.</p>`;
  return `<div class="pane-body"><div class="r1">
    <h2>Waiting on you <i>${rows.length} · ordered by what each one holds up</i></h2>
    ${rows.length ? `<ol class="ylist">${rows.join("")}</ol>` : `<p class="yempty">Nothing waits on you.</p>`}
    ${bounced.length ? `<div class="ygate"><b>Not shown here, by rule:</b> ${bounced.length} piece${bounced.length === 1 ? "" : "s"} marked ready without what the gate needs (${[...new Set(bounced.map((w) => w.bounced ?? ""))].map(esc).join("; ")}). They went back to their owners.</div>` : ""}
    ${parkedSection()}
    <h2>You decided <i>searchable by every agent with dak decisions</i></h2>${decided}
  </div></div>`;
}

/* ---------- Work ---------- */

const STATE_WORD: Record<string, string> = { next: "Next", doing: "Doing", ready: "Ready for you", held: "Held", done: "Done" };
const STAGE_WORD: Record<string, string> = { building: "Building", cursor: "In review", fixing: "Fixing", changes: "Fixing", proof: "Proving", review: "With you", approved: "Approved", merging: "Merging", held: "Held", blocked: "Blocked" };

export function workSub(): string {
  const open = P.work.filter((w) => w.state !== "done");
  const owners = new Set(open.map((w) => w.owner)).size;
  return `${open.length} open piece${open.length === 1 ? "" : "s"} · ${owners} owner${owners === 1 ? "" : "s"}`;
}

function workRow(w: WorkItem): string {
  const word = w.from_board && w.pr_stage ? STAGE_WORD[w.pr_stage] ?? STATE_WORD[w.state] : STATE_WORD[w.state];
  const cls = w.state === "ready" ? "you" : w.state === "held" ? "held" : w.state === "done" ? "ok" : "";
  const waits = w.state === "held" ? w.blocked ?? "" : w.bounced ? `Sent back: ${w.bounced}` : w.state === "ready" ? "You" : "";
  return `<li><button class="wi ${P.open === w.id ? "on" : ""}" data-work-open="${w.id}"><span class="wid">${w.id}</span>
    <div class="wt"><b>${w.pr ? `#${w.pr} ` : ""}${esc(w.title)}</b><div class="wsub"><span class="kind">${esc(w.kind)}</span>${ref(w.ticket)}</div></div>
    <span class="ws ${cls}">${esc(word)}</span><span class="ww">${waits ? `<i>${w.state === "held" ? "held on" : "waiting on"}</i>${esc(waits)}` : ""}</span></button></li>`;
}

function shipping(): string {
  const moving = S.queue.filter((r) => ["testing", "building", "merging", "merged", "migrated"].includes(r.state) && !r.hold);
  const waiting = S.queue.filter((r) => ["approved", "held", "failed"].includes(r.state) && !r.hold);
  const today = new Date().toDateString();
  const deployed = S.queue.filter((r) => r.state === "deployed" && new Date(r.state_since).toDateString() === today);
  const lane = (title: string, rows: typeof S.queue, empty: string) => `<div class="lane"><h3>${title} <i>${rows.length}</i></h3>
    ${rows.length ? rows.slice(0, 4).map((r) => `<button class="sc" ${r.thread_id ? `data-topic="${esc(r.thread_id)}"` : ""}><b>#${r.pr}</b> ${esc(r.title)}<span>${esc(r.state)}</span></button>`).join("")
      + (rows.length > 4 ? `<button class="link more" data-queue>${rows.length - 4} more</button>` : "") : `<p>${empty}</p>`}</div>`;
  return `<div class="ship">${lane("Moving", moving, "Nothing merging now.")}${lane("Approved, waiting", waiting, "Nothing approved is waiting.")}${lane("Deployed today", deployed, "Nothing deployed yet today.")}</div>`;
}

/* A piece, opened: what it is, where it stands on its track, its proof, and the way to its topic. */
const TRACK: [string, string][] = [["next", "Next"], ["doing", "Doing"], ["ready", "Ready for you"], ["done", "Done"]];
function workPanel(): string {
  const w = P.work.find((x) => x.id === P.open);
  if (!w) return "";
  const at = TRACK.findIndex(([k]) => k === w.state);
  const track = w.state === "held" ? `<div class="wtrack held"><b>Held</b>${w.blocked ? `: ${esc(w.blocked)}` : ""}</div>`
    : `<ol class="wtrack">${TRACK.map(([k, word], i) => `<li class="${i < at ? "past" : i === at ? "now" : ""}"><span></span>${word}${i === at && w.from_board && w.pr_stage ? ` · ${esc(STAGE_WORD[w.pr_stage] ?? w.pr_stage)}` : ""}</li>`).join("")}</ol>`;
  const fact = (k: string, v: string) => v ? `<dt>${k}</dt><dd>${v}</dd>` : "";
  return `<aside class="wpanel" role="dialog" aria-label="${esc(w.id)}"><header><span class="wid">${w.id}</span><span class="grow"></span>
      <button class="icon-btn" data-work-close aria-label="Close">${I.close}</button></header>
    <div class="wpbody"><h1>${w.pr ? `#${w.pr} ` : ""}${esc(w.title)}</h1>
      <dl class="wfacts">${fact("Owner", `${mark(w.owner, "sm")}${esc(name(w.owner))}`)}${fact("Kind", `<span class="kind">${esc(w.kind)}</span>`)}${fact("Ticket", ref(w.ticket))}
        ${fact("From", w.from_board ? "an open PR on the Board" : "made in Dak")}${fact("Started", when(w.created_at))}${fact("Last moved", when(w.updated_at))}</dl>
      <h3>Where it is</h3>${track}
      ${w.bounced ? `<h3>Sent back</h3><p class="wnote">${esc(w.bounced)}. It stays with ${esc(name(w.owner))} until it has them.</p>` : ""}
      <h3>Proof</h3><p class="wnote">${w.proof ? esc(w.proof) : w.from_board ? "In the PR's handoff on its topic." : "None yet. Done and Ready for you both need it."}</p>
      <div class="wacts">${w.thread_id ? `<button class="btn p" data-topic="${esc(w.thread_id)}">Open its topic</button>` : `<span class="wnote">No topic yet.</span>`}</div>
    </div></aside>`;
}

export function workView(): string {
  const open = P.work.filter((w) => w.state !== "done");
  const owners = [...new Set(open.map((w) => w.owner))];
  const groups = owners.map((o) => {
    const mine = open.filter((w) => w.owner === o);
    const doing = mine.filter((w) => w.state === "doing").length;
    return `<section class="owner"><header>${mark(o, "sm")}<b>${esc(name(o))}</b><span>${mine.length} piece${mine.length === 1 ? "" : "s"}${doing ? ` · ${doing} doing` : ""}</span></header>
      <ol>${mine.map(workRow).join("")}</ol></section>`;
  }).join("");
  const done = P.work.filter((w) => w.state === "done");
  return `<div class="pane-body"><div class="r1">
    ${P.error ? `<p class="yempty">${esc(P.error)}</p>` : ""}
    <h2>Shipping <i>the merge queue</i><button class="link" data-queue>Full queue</button></h2>${shipping()}
    <h2>By owner <i>every piece has one; code pieces come from each open PR</i><button class="link" data-board-open>Tickets</button></h2>
    ${groups || `<p class="yempty">No open work. An agent adds a piece with <code>dak work add "…" --owner &lt;agent&gt;</code>.</p>`}
    ${done.length ? `<h2>Done in the last day <i>${done.length}</i></h2><section class="owner"><ol>${done.map(workRow).join("")}</ol></section>` : ""}
  </div></div>${workPanel()}`;
}

/* ---------- Rules ---------- */

export function rulesView(): string {
  const r = P.rules;
  if (!r) return `<div class="pane-body"><div class="r1"><p class="yempty">Loading the rules.</p></div></div>`;
  const agents = [...new Set(S.agents.filter((a) => a.kind === "agent").map((a) => a.name))];
  return `<div class="pane-body"><div class="r1">
    <p class="lockline">${I.lock}Only you write this page. Agents read it with <code>dak rules</code>; no agent command changes it.</p>
    <h2>Kept by Dak <i>in code, whichever agent or tool is on the other end</i></h2>
    <div class="rules">${r.kept.map((k) => `<div class="rule"><div><b>${esc(k.text)}</b><div class="why">${esc(k.how)}</div></div><span class="by">${I.shield}Dak</span></div>`).join("")}</div>
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
