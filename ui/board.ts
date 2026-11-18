/* The Board page: the backlog on the left, one pile per engineer beside it, "Needs you" on top.
   Drag a ticket from the backlog onto an engineer to give it to them (they and Atlas are told),
   drag inside a pile to change the order, drag back to the backlog to take it away. Filters: one
   engineer, a label, a milestone, or words. On a phone it is a list, and assigning is a menu. */
import { S, esc, mark, when, name, onPhone } from "./state";
import { api } from "./api";
import { I } from "./icons";
import type { Card } from "../src/board";

export interface BoardData { cards: Card[]; labels: string[]; milestones: string[]; synced_at: string | null; linear: { connected: boolean } }

export async function loadBoard() {
  try { S.board = await api<BoardData>("/board"); } catch (e: any) { S.boardError = e.message ?? "Could not load the Board."; }
}

const STAGE: Record<string, [string, string]> = {
  backlog: ["Backlog", ""], next: ["Up next", ""], brief: ["Brief", ""], building: ["Building", ""], review: ["In review", ""],
  you: ["Needs you", "you"], changes: ["Changes", "warn"], approved: ["Approved", "ok"], merging: ["Merging", ""], live: ["Live", "ok"],
  checking: ["Checking", ""], done: ["Done", "ok"],
};

function filtered(cards: Card[]): Card[] {
  const f = S.boardFilter;
  const words = f.q.trim().toLowerCase();
  return cards.filter((c) => (!f.label || c.labels.includes(f.label)) && (!f.milestone || c.milestone === f.milestone)
    && (!words || `${c.id} ${c.title}`.toLowerCase().includes(words)));
}

// The engineers shown as piles: every named agent (a reader, a member you carded, a session with a
// title, anyone outside this Mac, anyone holding tickets), idle or not, so nobody drops off. A
// session found by its folder often shares its title with the named one ("Tasks engineer (M9)"):
// one pile per title, the named one kept.
function engineers(cards: Card[]): { name: string; label: string; role: string; last: string | null }[] {
  const piles = new Set(cards.map((c) => c.agent).filter(Boolean) as string[]);
  const score = (m: any) => (piles.has(m.name) ? 0 : m.reader ? 1 : m.carded ? 2 : 3) * 1000 + m.name.length;
  const best = new Map<string, any>();
  for (const m of (S.team ?? []) as any[]) {
    if (m.kind === "person") continue;
    if (!(S.boardAll || piles.has(m.name) || m.reader || m.carded || m.display || m.kind === "cloud" || m.kind === "bot")) continue;
    const key = S.boardAll ? m.name : (m.display || m.name).toLowerCase();
    const cur = best.get(key);
    if (!cur || score(m) < score(cur)) best.set(key, m);
  }
  // A session title like "Atlas - CTO @ Reva" or "Tasks engineer (M9)" reads as "Atlas", "Tasks engineer".
  const short = (d: string) => d.split(/ - | \(| @ /)[0].trim() || d;
  return [...best.values()].map((m) => ({ name: m.name, label: m.display ? short(m.display) : m.name, role: [m.role, m.area].filter(Boolean).join(" · "), last: m.last_seen }));
}

function cardHtml(c: Card, draggable: boolean): string {
  const [word, cls] = STAGE[c.stage] ?? [c.stage, ""];
  const work = c.work.slice(-3).map((w) => `<button class="bw" data-topic="${esc(w.thread)}" title="Open on Dak">${w.kind === "pr" ? I.pr : I.doc}<span>${esc(w.label)}</span><i class="st ${STAGE[w.state]?.[1] ?? ""}">${esc(STAGE[w.state]?.[0] ?? w.state)}</i></button>`).join("");
  const assign = onPhone() ? `<label class="popup bassign"><select data-board-assign="${esc(c.id)}" aria-label="Give ${esc(c.id)} to"><option value="">${c.agent ? `@${esc(c.agent)}` : "Give to…"}</option>
    ${(S.team ?? []).filter((m: any) => m.kind !== "person").map((m: any) => `<option value="${esc(m.name)}">${esc(m.display || m.name)}</option>`).join("")}${c.agent ? `<option value="none">Back to the backlog</option>` : ""}</select></label>` : "";
  return `<article class="bcard ${c.needs_you ? "you" : ""}" ${draggable ? `draggable="true"` : ""} data-card="${esc(c.id)}">
    <div class="bc-top"><code>${esc(c.id)}</code><span class="bstage ${cls}">${word}</span></div>
    <p class="bc-title">${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title)}</p>
    ${c.stage_note ? `<p class="bc-note">${esc(c.stage_note)}</p>` : ""}
    ${c.labels.length || c.milestone ? `<div class="bc-labels">${c.milestone ? `<span class="ms">${esc(c.milestone)}</span>` : ""}${c.labels.map((l) => `<span>${esc(l)}</span>`).join("")}</div>` : ""}
    ${work ? `<div class="bc-work">${work}</div>` : ""}${assign}</article>`;
}

function connectBox(b: BoardData | null): string {
  if (b?.linear.connected) return "";
  return `<div class="linear-connect"><div><b>Bring in your Linear backlog</b><span>In Linear: Settings → Security &amp; access → Personal API keys → New key (read-only is enough). Paste it here. It stays in a private file on this Mac and is only sent to Linear.</span></div>
    <input class="input" id="linear-key" type="password" placeholder="lin_api_…" autocomplete="off" spellcheck="false"><button class="btn primary" data-linear-connect>Connect</button>
    ${S.boardError ? `<p class="err">${esc(S.boardError)}</p>` : ""}</div>`;
}

export function boardView(): string {
  const b: BoardData | null = S.board;
  if (!b) return `<div class="pane-body"><div class="blank"><p>${S.boardError ? esc(S.boardError) : "Loading the Board…"}</p></div></div>`;
  const f = S.boardFilter;
  const cards = filtered(b.cards);
  const eng = engineers(b.cards);
  const backlog = cards.filter((c) => !c.agent && c.stage !== "done").sort((x, y) => (x.priority || 9) - (y.priority || 9));
  const needs = cards.filter((c) => c.needs_you);
  const pile = (n: string) => cards.filter((c) => c.agent === n).sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
  const shownEng = f.agent ? eng.filter((e) => e.name === f.agent) : eng;
  const chips = `<div class="bfilters"><button class="chip-f ${!f.agent ? "on" : ""}" data-board-agent="">Everyone</button>${eng.map((e) => `<button class="chip-f ${f.agent === e.name ? "on" : ""}" data-board-agent="${esc(e.name)}">${esc(e.label)} <b>${pile(e.name).filter((c) => c.stage !== "done").length}</b></button>`).join("")}
    <span class="grow"></span>
    ${b.labels.length ? `<label class="popup"><select data-board-label aria-label="Label"><option value="">All labels</option>${b.labels.map((l) => `<option ${f.label === l ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : ""}
    ${b.milestones.length ? `<label class="popup"><select data-board-milestone aria-label="Milestone"><option value="">All milestones</option>${b.milestones.map((m) => `<option ${f.milestone === m ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label>` : ""}
    <input class="input bsearch" id="board-q" type="search" placeholder="Find a ticket" value="${esc(f.q)}" autocomplete="off"></div>`;
  const needsRow = needs.length ? `<section class="bneeds"><h3>${I.check} Needs you <b>${needs.length}</b></h3><div class="brow">${needs.map((c) => cardHtml(c, false)).join("")}</div></section>` : "";
  const col = (key: string, title: string, sub: string, list: Card[], head = "") => `<section class="bcol" data-drop="${esc(key)}"><header>${head}<div><b>${esc(title)}</b><span>${sub}</span></div><i>${list.length}</i></header>
    <div class="bcol-list">${list.map((c) => cardHtml(c, !onPhone())).join("") || `<p class="bempty">${key === "" ? "Nothing waiting." : "Nothing in this pile. Drag a ticket here."}</p>`}</div></section>`;
  const idle = (e: { name: string; last: string | null }) => {
    const p = pile(e.name);
    const moving = p.find((c) => ["building", "review", "changes", "you", "merging"].includes(c.stage));
    return moving ? `On ${esc(moving.id)}` : e.last ? `Idle since ${when(e.last)}` : "Idle";
  };
  const cols = shownEng.map((e) => col(e.name, e.label, `${e.role ? `${esc(e.role)} · ` : ""}${idle(e)}`, pile(e.name), mark(e.name, "sm"))).join("");
  const synced = b.linear.connected ? `Linear synced ${b.synced_at ? when(b.synced_at) : "not yet"} · <button class="link" data-board-sync>Refresh</button> · <button class="link" data-linear-disconnect>Disconnect</button>` : "";
  return `<div class="pane-body board-page">${connectBox(b)}${chips}${needsRow}
    <div class="bcols">${col("", "Backlog", `${backlog.length} open`, backlog)}${cols}</div>
    <p class="qfoot">${synced}${synced ? " · " : ""}<button class="link" data-board-all>${S.boardAll ? "Only engineers with a card" : "Show every agent"}</button>. Engineers take the top of their pile with <code>dak next</code> and say where they are with <code>dak status &lt;ticket&gt; "…"</code>.</p></div>`;
}

export const boardSub = () => {
  const b: BoardData | null = S.board;
  if (!b) return "";
  const open = b.cards.filter((c) => c.stage !== "done");
  return `${open.length} open · ${open.filter((c) => c.agent).length} assigned · ${b.cards.filter((c) => c.needs_you).length} need you`;
};

// Drag and drop: where a card lands in a pile is "before" the card under the pointer.
let dragging: string | null = null;
export function wireBoardDrag(onDrop: (task: string, agent: string | null, before: string | null) => void) {
  document.addEventListener("dragstart", (e) => {
    const c = (e.target as HTMLElement).closest?.<HTMLElement>(".bcard[data-card]");
    if (!c) return;
    dragging = c.dataset.card!; e.dataTransfer?.setData("text/plain", dragging); c.classList.add("dragging");
  });
  document.addEventListener("dragend", () => { dragging = null; document.querySelectorAll(".dragging,.drop-on").forEach((x) => x.classList.remove("dragging", "drop-on")); });
  document.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const col = (e.target as HTMLElement).closest?.<HTMLElement>(".bcol[data-drop]");
    if (!col) return;
    e.preventDefault();
    document.querySelectorAll(".drop-on").forEach((x) => x !== col && x.classList.remove("drop-on"));
    col.classList.add("drop-on");
  });
  document.addEventListener("drop", (e) => {
    if (!dragging) return;
    const col = (e.target as HTMLElement).closest?.<HTMLElement>(".bcol[data-drop]");
    if (!col) return;
    e.preventDefault();
    const agent = col.dataset.drop || null;
    const under = [...col.querySelectorAll<HTMLElement>(".bcard[data-card]")].find((x) => x.dataset.card !== dragging && e.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
    const task = dragging; dragging = null;
    onDrop(task, agent, agent ? under?.dataset.card ?? null : null);
  });
}

export const nameOf = (n: string) => name(n);
