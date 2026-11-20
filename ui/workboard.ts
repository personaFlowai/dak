/* The Work board: every piece as a card in the stage it is in, one column per stage (the
   person's own list, from Rules), or one row per owner across those stages. A card says what it
   is, whose it is and how long it has sat there; past its stage's limit that time turns amber,
   which is how "who is stuck" reads at a glance. The same filters as the Board page. */
import { api } from "./api";
import { S, esc, me, name, mark, when } from "./state";
import { I, ticketMark } from "./icons";
import { P, type WorkItem } from "./places";
import { FL, linearButton, linearPanel } from "./fromlinear";

export interface Stage { name: string; gate: "start" | "work" | "review" | "done"; stuck_hours: number | null; pr: string }
export const WB = {
  stages: {} as Record<string, Stage[]>,
  kind: "code", mode: "stages" as "stages" | "team", stuck: false, owners: [] as string[], labels: [] as string[], q: "", menu: "" as "" | "owner" | "label", moveError: "", assigning: false,
};
const KIND_WORD: Record<string, string> = { code: "Code", mock: "Mock", research: "Research", doc: "Doc", email: "Email", note: "Note" };

export async function loadStages() { try { WB.stages = await api("/stages"); } catch { /* the board waits for them */ } }

const hours = (w: WorkItem) => (Date.now() - Date.parse(w.stage_since)) / 3_600_000;
const age = (h: number) => h < 1 ? "now" : h < 24 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
const stageOf = (w: WorkItem) => (WB.stages[w.kind] ?? []).find((s) => s.name === w.stage);
export const isStuck = (w: WorkItem) => { const s = stageOf(w); return w.held || (!!s?.stuck_hours && w.state !== "done" && hours(w) > s.stuck_hours); };

// Done pieces stay on the board for a day, in the last column, then leave it.
const ofKind = () => P.work.filter((w) => w.kind === WB.kind);
function shown(): WorkItem[] {
  const q = WB.q.trim().toLowerCase();
  return ofKind().filter((w) => (!WB.owners.length || WB.owners.includes(w.owner)) && (!WB.labels.length || w.labels.some((l) => WB.labels.includes(l)))
    && (!WB.stuck || isStuck(w)) && (!q || `${w.id} ${w.ticket ?? ""} ${w.title} ${w.pr ? `#${w.pr}` : ""}`.toLowerCase().includes(q)));
}

export function workSub(): string {
  const all = ofKind();
  const owners = new Set(all.map((w) => w.owner)).size;
  return `${all.length} piece${all.length === 1 ? "" : "s"} · ${owners} owner${owners === 1 ? "" : "s"}`;
}

// The toolbar's right side: kind, view, Stuck, and the Board page's filters.
export function workTools(): string {
  const kinds = Object.keys(KIND_WORD).filter((k) => k === "code" || P.work.some((w) => w.kind === k));
  const stuck = ofKind().filter(isStuck).length;
  const caret = I.next;
  const menu = (kind: "owner" | "label", items: [string, string, number][], picked: string[]) => WB.menu !== kind ? "" :
    `<div class="wb-menu" role="listbox"><button data-wb-${kind}=""><span class="chk">${picked.length ? "" : I.check}</span>${kind === "owner" ? "Everyone" : "Any label"}</button>
      ${items.map(([v, label, n]) => `<button data-wb-${kind}="${esc(v)}"><span class="chk">${picked.includes(v) ? I.check : ""}</span>${kind === "owner" ? mark(v, "sm") : ""}<span class="l">${esc(label)}</span><span class="n">${n}</span></button>`).join("")}</div>`;
  const owners = [...new Set(ofKind().map((w) => w.owner))].map((o) => [o, o ? name(o) : "Not assigned", ofKind().filter((w) => w.owner === o).length] as [string, string, number]);
  const labels = [...new Set(ofKind().flatMap((w) => w.labels))].sort().map((l) => [l, l, ofKind().filter((w) => w.labels.includes(l)).length] as [string, string, number]);
  const ownerL = !WB.owners.length ? "Everyone" : WB.owners.length === 1 ? name(WB.owners[0]) : `${WB.owners.length} people`;
  const labelL = !WB.labels.length ? "Label" : WB.labels.join(", ");
  return `<div class="seg" role="group" aria-label="Kind">${kinds.map((k) => `<button data-wb-kind="${k}" aria-pressed="${WB.kind === k}">${KIND_WORD[k]}</button>`).join("")}</div>
    <div class="seg" role="group" aria-label="View"><button data-wb-mode="stages" aria-pressed="${WB.mode === "stages"}">Stages</button><button data-wb-mode="team" aria-pressed="${WB.mode === "team"}">Team</button></div>
    ${stuck ? `<button class="wb-stuck" data-wb-stuck aria-pressed="${WB.stuck}">Stuck <b>${stuck}</b></button>` : ""}
    <div class="wb-dd"><button class="wb-ddb ${WB.owners.length ? "on" : ""}" data-wb-menu="owner" aria-expanded="${WB.menu === "owner"}">${esc(ownerL)}<span class="cv">${caret}</span></button>${menu("owner", owners, WB.owners)}</div>
    ${labels.length ? `<div class="wb-dd"><button class="wb-ddb ${WB.labels.length ? "on" : ""}" data-wb-menu="label" aria-expanded="${WB.menu === "label"}">${esc(labelL)}<span class="cv">${caret}</span></button>${menu("label", labels, WB.labels)}</div>` : ""}
    <input id="wb-q" class="wb-q" type="search" placeholder="Find W-12, a ticket or title" value="${esc(WB.q)}" autocomplete="off">
    ${linearButton()}`;
}

function card(w: WorkItem): string {
  const h = hours(w), stuck = isStuck(w);
  return `<button class="wb-card ${stuck ? "stuck" : ""} ${P.open === w.id ? "on" : ""}" data-work-open="${w.id}" title="${esc(w.id)}${w.ticket ? ` · ${esc(w.ticket)}` : ""}">
    <span class="t">${w.pr ? `<i>#${w.pr}</i> ` : ""}${esc(w.title)}</span>
    <span class="m">${w.owner ? `${mark(w.owner, "sm")}<span class="o">${esc(name(w.owner))}</span>` : `<span class="o none">Not assigned</span>`}${w.ticket ? `<code>${esc(w.ticket)}</code>` : ""}<span class="a" title="${w.held ? `Held${w.blocked ? `: ${esc(w.blocked)}` : ""}` : "In this stage"}">${w.held ? "Held" : age(h)}</span></span></button>`;
}

const ring = (s: Stage, i: number, n: number) => s.gate === "review" ? "you" : s.gate === "done" ? "full" : i === 0 ? "" : i < n / 3 ? "p1" : i < (2 * n) / 3 ? "p2" : "p3";

function stagesBoard(): string {
  const st = WB.stages[WB.kind] ?? [], list = shown();
  return `<div class="wb-cols">${st.map((s, i) => {
    const ws = list.filter((w) => w.stage === s.name);
    return `<section class="wb-col"><h3><span class="ring ${ring(s, i, st.length)}"></span><span class="${s.gate === "review" ? "you" : ""}">${esc(s.name)}</span> <i>${ws.length}</i></h3>
      <div class="wb-lane">${ws.map(card).join("") || `<p class="wb-empty">Nothing here</p>`}</div></section>`;
  }).join("")}</div>`;
}

function teamBoard(): string {
  const st = WB.stages[WB.kind] ?? [], list = shown();
  const cols = `grid-template-columns: 180px repeat(${st.length}, 210px)`;
  const owners = [...new Set(list.map((w) => w.owner))].sort((a, b) => list.filter((w) => w.owner === b && isStuck(w)).length - list.filter((w) => w.owner === a && isStuck(w)).length || name(a).localeCompare(name(b)));
  const rows = owners.map((o) => {
    const mine = list.filter((w) => w.owner === o), stuck = mine.filter(isStuck).length;
    return `<div class="wb-row" style="${cols}"><div class="wb-who">${o ? mark(o, "sm") : ""}<div><b>${o ? esc(name(o)) : "Not assigned"}</b><span>${mine.length} piece${mine.length === 1 ? "" : "s"}${stuck ? ` · <em>${stuck} stuck</em>` : ""}</span></div></div>
      ${st.map((s) => `<div class="wb-cell">${mine.filter((w) => w.stage === s.name).map((w) => `<button class="wb-chip ${isStuck(w) ? "stuck" : ""}" data-work-open="${w.id}" title="${esc(w.title)}"><span>${w.pr ? `#${w.pr} ` : ""}${esc(w.title)}</span>${isStuck(w) ? `<b>${w.held ? "Held" : age(hours(w))}</b>` : ""}</button>`).join("")}</div>`).join("")}</div>`;
  }).join("");
  return `<div class="wb-team"><div class="wb-row head" style="${cols}"><div></div>${st.map((s) => `<div class="${s.gate === "review" ? "you" : ""}">${esc(s.name)}</div>`).join("")}</div>
    ${rows || `<p class="wb-empty">Nothing matches.</p>`}</div>`;
}

export function workView(): string {
  const none = !ofKind().length;
  return `<div class="pane-body wb">${P.error ? `<p class="yempty">${esc(P.error)}</p>` : ""}
    ${none ? `<p class="yempty">No ${KIND_WORD[WB.kind]?.toLowerCase()} work yet. Agents add a piece with <code>dak work add "…" --kind ${esc(WB.kind)}</code>; code pieces come from each open PR on the Board.</p>`
      : WB.mode === "team" ? teamBoard() : stagesBoard()}</div>${FL.open ? linearPanel() : workPanel()}`;
}

/* A piece, opened: what it is, where it stands on its kind's stages and for how long, its proof,
   and the way to its topic. You can move it to any stage; an agent moves only its own. */
function workPanel(): string {
  const w = P.work.find((x) => x.id === P.open);
  if (!w) return "";
  const st = WB.stages[w.kind] ?? [];
  const at = st.findIndex((s) => s.name === w.stage);
  const track = `<ol class="wb-track">${st.map((s, i) => `<li class="${i < at ? "past" : i === at ? `now ${isStuck(w) ? "stuck" : ""}` : ""}"><i></i><span>${esc(s.name)}</span>
    <small>${i === at ? (w.held ? `held${w.blocked ? `: ${esc(w.blocked)}` : ""}` : `${age(hours(w))} here${s.stuck_hours ? `, limit ${age(s.stuck_hours)}` : ""}`) : s.gate === "review" ? "needs proof and a briefing" : s.gate === "done" ? "needs proof" : ""}</small></li>`).join("")}</ol>`;
  const fact = (k: string, v: string) => v ? `<dt>${k}</dt><dd>${v}</dd>` : "";
  return `<aside class="wpanel" role="dialog" aria-label="${esc(w.id)}"><header><span class="wid">${w.id}</span><span class="grow"></span>
      <button class="icon-btn" data-work-close aria-label="Close">${I.close}</button></header>
    <div class="wpbody"><h1>${w.pr ? `#${w.pr} ` : ""}${esc(w.title)}</h1>
      <dl class="wfacts">${fact("Owner", w.from_board ? `${mark(w.owner, "sm")}${esc(name(w.owner))}` : assignMenu(w))}${fact("Kind", `<span class="kind">${esc(w.kind)}</span>`)}${fact("Ticket", w.ticket ? `<span class="ref">${ticketMark(w.ticket)}${esc(w.ticket)}</span>` : "")}
        ${fact("Moves", w.from_board ? "by itself, from its PR" : w.owner ? `by ${esc(name(w.owner))}, with dak work stage` : "once it has an owner")}${fact("Started", when(w.created_at))}</dl>
      <h3>Where it is</h3>${track}
      ${w.bounced ? `<h3>Sent back</h3><p class="wnote">${esc(w.bounced)}. It stays with ${esc(name(w.owner))} until it has them.</p>` : ""}
      <h3>Proof</h3><p class="wnote">${w.proof ? esc(w.proof) : w.from_board ? "In the PR's handoff on its topic." : "None yet. Your review and the last stage both need it."}</p>
      <div class="wacts">${w.thread_id ? `<button class="btn p" data-topic="${esc(w.thread_id)}">Open its topic</button>` : `<button class="btn p" data-work-topic="${esc(w.id)}">${I.chat}Start a topic</button>`}
        <label class="wb-move">Move to <select data-wb-move="${esc(w.id)}" aria-label="Move to stage">${st.map((s) => `<option ${s.name === w.stage ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
</div>
      ${WB.moveError ? `<p class="err">${esc(WB.moveError)}</p>` : ""}
    </div></aside>`;
}

/* Owner: a menu of the team, like giving work to a person, and a new agent at the foot. */
function assignMenu(w: WorkItem): string {
  const team = (S.team ?? []).filter((m: any) => m.kind !== "person" && m.kind !== "bot" && m.name !== w.owner);
  const count = (n: string) => P.work.filter((x) => x.owner === n && x.state !== "done").length;
  return `<div class="wb-assign"><button class="wb-ddb" data-wb-assign aria-expanded="${WB.assigning}">${w.owner ? `${mark(w.owner, "sm")}${esc(name(w.owner))}` : "Not assigned"}<span class="cv">${I.next}</span></button>
    ${WB.assigning ? `<div class="wb-menu" role="listbox">${team.map((m: any) => `<button data-wb-assign-to="${esc(m.name)}">${mark(m.name, "sm")}<span class="l"><b>${esc(m.display || name(m.name))}</b><br><small>${esc(m.role ?? m.area ?? "")}${m.role || m.area ? " · " : ""}${count(m.name)} piece${count(m.name) === 1 ? "" : "s"}</small></span></button>`).join("")}
      <div class="wb-sep"></div><button data-work-start="${esc(w.id)}"><span class="mark sm">${I.compose}</span><span class="l"><b>Start a new agent…</b><br><small>Joins the team, with this piece</small></span></button></div>` : ""}</div>`;
}

export async function assignTo(id: string, owner: string) {
  WB.moveError = ""; WB.assigning = false;
  try { await api(`/work/${encodeURIComponent(id)}/assign`, { method: "POST", body: { owner, by: me } }); }
  catch (e: any) { WB.moveError = e.message ?? "Could not assign it."; }
}

export async function moveTo(id: string, stage: string) {
  WB.moveError = "";
  try { await api(`/work/${encodeURIComponent(id)}/stage`, { method: "POST", body: { stage, by: me } }); }
  catch (e: any) { WB.moveError = e.message ?? "Could not move it."; }
}
