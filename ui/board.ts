/* The Board page, as the approved mock: one slim bar (Piles / Stages, Needs you, Engineer, Label,
   Milestone, search), the backlog as a compact list grouped by milestone, and one pile per
   engineer with Linear-style cards. Drag a backlog row (or a card) onto an engineer to give it to
   them; drag inside a pile to reorder; drag to the backlog to take it away. Tapping a card opens
   its panel on the right: the ticket, who has it, where it stands, its work, and its history. */
import { S, esc, mark, when, fullWhen, onPhone } from "./state";
import { api } from "./api";
import { I } from "./icons";
import type { Card } from "../src/board";

export interface BoardData { cards: Card[]; labels: string[]; milestones: string[]; synced_at: string | null; linear: { connected: boolean } }

export async function loadBoard() {
  try { S.board = await api<BoardData>("/board"); S.boardError = ""; } catch (e: any) { S.boardError = e.message ?? "Could not load the Board."; }
}

const STAGES: [string, string][] = [["next", "Up next"], ["you", "Needs you"], ["blocked", "Blocked"], ["review", "In review"],
  ["changes", "Changes asked"], ["approved", "Approved"], ["merging", "Merging"], ["checking", "Checking"]];
const SNAME: Record<string, string> = Object.fromEntries([["backlog", "Backlog"], ...STAGES, ["done", "Done"], ["live", "Live"]]);

// A ring that fills as a ticket moves, as Linear draws status; a check once it is finished; a bar
// across it when it is blocked.
function glyph(s: string): string {
  const c = s === "you" ? "var(--accent)" : ["approved", "checking", "live", "done"].includes(s) ? "var(--add)" : ["changes", "blocked"].includes(s) ? "var(--warn-text, #9a5b00)" : "var(--text3)";
  if (s === "blocked") return `<svg class="g" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.4"/><path d="M3.6 7h6.8" stroke="${c}" stroke-width="1.6"/></svg>`;
  const frac = ({ backlog: -1, next: 0, you: .5, review: .55, changes: .45, approved: .8, merging: .9, checking: .97, live: 1, done: 1 } as Record<string, number>)[s] ?? 0;
  if (frac < 0) return `<svg class="g" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.4" stroke-dasharray="2 2"/></svg>`;
  if (frac >= 1) return `<svg class="g" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="${c}"/><path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="#fff" stroke-width="1.5"/></svg>`;
  const a = frac * 2 * Math.PI, x = 7 + 3.2 * Math.sin(a), y = 7 - 3.2 * Math.cos(a), big = frac > .5 ? 1 : 0;
  return `<svg class="g" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${c}" stroke-width="1.4"/>${frac > 0 ? `<path d="M7 7 L7 3.8 A3.2 3.2 0 ${big} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z" fill="${c}"/>` : ""}</svg>`;
}
// Linear's priority: 1 urgent, 2 high, 3 medium, 4 low, 0 none.
const pri = (p: number | null) => p === 1 ? `<span class="pri urgent" title="Urgent">!</span>`
  : `<span class="pri" title="${["No priority", "Urgent", "High", "Medium", "Low"][p ?? 0]}">${[1, 2, 3].map((i) => `<i class="${p && p > 1 && 5 - p >= i ? "f" : ""}" style="height:${3 + i * 3}px"></i>`).join("")}</span>`;
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h} 45% 52%)`; };
const lab = (l: string) => `<span class="blab" style="--c:${hue(l)}">${esc(l)}</span>`;
const short = (d: string) => d.split(/ - | \(| @ /)[0].trim() || d;

// The engineers with a pile: every named agent (a reader, a member you carded, a session with a
// title, anyone outside this Mac, anyone holding tickets), idle or not. A session found by its
// folder often shares its title with the named one: one pile per title, the named one kept.
export function engineers(cards: Card[]): { name: string; label: string; last: string | null }[] {
  const piles = new Set(cards.map((c) => c.agent).filter(Boolean) as string[]);
  const score = (m: any) => (piles.has(m.name) ? 0 : m.reader ? 1 : m.carded ? 2 : 3) * 1000 + m.name.length;
  const best = new Map<string, any>();
  for (const m of (S.team ?? []) as any[]) {
    if (m.kind === "person") continue;
    if (!(piles.has(m.name) || m.reader || m.carded || m.display || m.kind === "cloud" || m.kind === "bot")) continue;
    const key = (m.display || m.name).toLowerCase();
    const cur = best.get(key);
    if (!cur || score(m) < score(cur)) best.set(key, m);
  }
  return [...best.values()].map((m) => ({ name: m.name, label: m.display ? short(m.display) : m.name, last: m.last_seen }));
}

function shown(cards: Card[]): Card[] {
  const f = S.boardFilter, q = f.q.trim().toLowerCase();
  return cards.filter((c) => (!f.label || c.labels.includes(f.label)) && (!f.milestone || c.milestone === f.milestone)
    && (!q || `${c.id} ${c.title}`.toLowerCase().includes(q)) && (!f.needs || c.needs_you));
}

function card(c: Card, who: string | null): string {
  const prs = c.work.filter((w) => w.kind === "pr").length;
  const meta = [who ? `<span class="bwho">${mark(c.agent!, "sm")}${esc(who)}</span>` : "", ...c.labels.slice(0, who ? 1 : 2).map(lab),
    prs ? `<span class="bprs">${I.pr}${prs}</span>` : ""].join("");
  return `<article class="bcard ${S.boardOpen === c.id ? "on" : ""} ${c.now ? "now" : ""}" draggable="${onPhone() ? "false" : "true"}" data-card="${esc(c.id)}" tabindex="0">
    <div class="bc-top">${c.now ? `<span class="bnow">Now</span>` : ""}${c.needs_you ? `<span class="bdot" title="Needs you"></span>` : ""}<code>${esc(c.id)}</code><span class="bstage">${glyph(c.stage)}${SNAME[c.stage] ?? c.stage}</span></div>
    <p class="bc-title">${esc(c.title)}</p>
    ${c.stage_note ? `<p class="bc-note">${esc(c.stage_note)}</p>` : ""}
    ${c.stage === "blocked" && c.status?.blocked ? `<p class="bc-blocked">Blocked on ${esc(c.status.blocked)}</p>` : ""}
    ${meta ? `<div class="bc-meta">${meta}</div>` : ""}</article>`;
}

function backlogPane(list: Card[]): string {
  const bl = list.filter((c) => !c.agent && c.stage !== "done").sort((x, y) => ((x.priority || 9) - (y.priority || 9)) || x.id.localeCompare(y.id));
  const groups = new Map<string, Card[]>();
  for (const c of bl) { const k = c.milestone || "No milestone"; (groups.get(k) ?? groups.set(k, []).get(k)!).push(c); }
  const html = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, cs]) => {
    const closed = S.boardClosed.includes(k);
    return `<button class="bgrp ${closed ? "closed" : ""}" data-board-grp="${esc(k)}" aria-expanded="${!closed}">${I.next}<span>${esc(k)}</span><i>${cs.length}</i></button>
      ${closed ? "" : cs.map((c) => `<div class="brow ${S.boardOpen === c.id ? "on" : ""}" draggable="${onPhone() ? "false" : "true"}" data-card="${esc(c.id)}" title="${esc(c.title)}">${pri(c.priority)}<code>${esc(c.id)}</code><span>${esc(c.title)}</span></div>`).join("")}`;
  }).join("");
  // Folded, the backlog is a slim strip that still takes drops; one tap opens it again.
  if (S.backlogFolded) return `<aside class="bbacklog bcol folded" data-drop=""><button class="bfold" data-board-fold title="Show the backlog" aria-label="Show the backlog, ${bl.length} open">${I.next}<span>Backlog</span><i>${bl.length}</i></button></aside>`;
  return `<aside class="bbacklog bcol" data-drop=""><header><b>Backlog</b><span>${bl.length} open</span><span class="grow"></span><button class="icon-btn" data-board-fold title="Fold the backlog away" aria-label="Fold the backlog away">${I.prev}</button></header><div class="bbl">${html || `<p class="bempty">Nothing matches.</p>`}</div></aside>`;
}

function dropdown(kind: "agent" | "label" | "milestone", eng: { name: string; label: string }[], b: BoardData): string {
  const f = S.boardFilter;
  const cur = kind === "agent" ? f.agent : kind === "label" ? f.label : f.milestone;
  const label = kind === "agent" ? (cur ? eng.find((e) => e.name === cur)?.label ?? cur : "Everyone") : kind === "label" ? cur || "Label" : cur ? cur.replace(/^\d+\.\s*/, "") : "Milestone";
  const items: [string, string, number | ""][] = kind === "agent" ? [["", "Everyone", b.cards.filter((c) => c.agent).length], ...eng.map((e) => [e.name, e.label, b.cards.filter((c) => c.agent === e.name).length] as [string, string, number])]
    : kind === "label" ? [["", "Any label", ""], ...b.labels.map((l) => [l, l, b.cards.filter((c) => c.labels.includes(l)).length] as [string, string, number])]
    : [["", "Any milestone", ""], ...b.milestones.map((m) => [m, m, b.cards.filter((c) => c.milestone === m).length] as [string, string, number])];
  const menu = S.boardMenu === kind ? `<div class="menu bmenu" role="menu">${items.map(([v, l, n]) => `<button class="mi" data-board-pick="${kind}" data-v="${esc(v)}"><span class="chk">${cur === v ? I.check : ""}</span>${kind === "label" && v ? lab(l) : `<span class="ml">${esc(l)}</span>`}<i>${n}</i></button>`).join("")}</div>` : "";
  return `<div class="more-wrap bdd"><button class="bddb ${cur ? "on" : ""}" data-board-menu="${kind}" aria-haspopup="menu" aria-expanded="${S.boardMenu === kind}"><span>${esc(label)}</span>${I.next}</button>${menu}</div>`;
}

// The bar under the window's toolbar: views on the left, filters on the right.
function bar(b: BoardData, eng: { name: string; label: string }[]): string {
  const f = S.boardFilter;
  const needs = b.cards.filter((c) => c.needs_you).length;
  return `<div class="bbar"><div class="seg mini" role="group" aria-label="View"><button data-board-view="piles" aria-pressed="${S.boardView === "piles"}">Piles</button><button data-board-view="stages" aria-pressed="${S.boardView === "stages"}">Stages</button></div>
    <span class="grow"></span>
    ${needs ? `<button class="bneedsb" data-board-needs aria-pressed="${f.needs}">Needs you <b>${needs}</b></button>` : ""}
    ${dropdown("agent", eng, b)}${b.labels.length ? dropdown("label", eng, b) : ""}${b.milestones.length ? dropdown("milestone", eng, b) : ""}
    <input class="input bsearch" id="board-q" type="search" placeholder="Find a ticket" value="${esc(f.q)}" autocomplete="off"></div>`;
}

function connectBox(b: BoardData): string {
  if (b.linear.connected) return "";
  return `<div class="linear-connect"><div><b>Bring in your Linear backlog</b><span>In Linear: Settings → Security &amp; access → Personal API keys → New key (read-only is enough). It stays in a private file on this Mac and is only sent to Linear.</span></div>
    <input class="input" id="linear-key" type="password" placeholder="lin_api_…" autocomplete="off" spellcheck="false"><button class="btn primary" data-linear-connect>Connect</button>
    ${S.boardError ? `<p class="err">${esc(S.boardError)}</p>` : ""}</div>`;
}

// The panel for one ticket, beside the board.
function panel(c: Card, eng: { name: string; label: string }[]): string {
  const who = c.agent ? eng.find((e) => e.name === c.agent)?.label ?? c.agent : null;
  const assign = `<label class="popup"><select data-board-assign="${esc(c.id)}" aria-label="Who has it"><option value="none" ${c.agent ? "" : "selected"}>Backlog: nobody</option>
    ${eng.map((e) => `<option value="${esc(e.name)}" ${c.agent === e.name ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select></label>`;
  const since = c.last_word ?? c.assigned_at;
  const work = c.work.length ? c.work.map((w) => `<button class="bp-work" data-topic="${esc(w.thread)}">${w.kind === "pr" ? I.pr : I.doc}<span>${esc(w.label)}</span><i class="bstage">${glyph(w.state)}${SNAME[w.state] ?? w.state}</i></button>`).join("")
    : `<p class="bp-empty">Nothing linked yet. A Dak topic or PR whose subject or title names ${esc(c.id)} shows here.</p>`;
  const hist = c.history.length ? c.history.slice().reverse().map((h) => `<li><span>${esc(h.what)}</span><time title="${esc(fullWhen(h.at))}">${when(h.at)}</time></li>`).join("") : "";
  return `<aside class="bpanel" aria-label="${esc(c.id)}">
    <header><code>${esc(c.id)}</code><span class="grow"></span>${c.url ? `<a class="icon-btn" href="${esc(c.url)}" target="_blank" rel="noopener" title="Open in Linear">${I.external}</a>` : ""}<button class="icon-btn" data-board-close title="Close (Esc)" aria-label="Close">${I.close}</button></header>
    <div class="bp-body">
      <h2>${esc(c.title)}</h2>
      <dl class="bp-facts">
        <dt>Stage</dt><dd>${c.now ? `<span class="bnow">Now</span>` : ""}<span class="bstage">${glyph(c.stage)}${SNAME[c.stage] ?? c.stage}</span>${since ? ` <span class="dim">last word ${when(since)}</span>` : ""}</dd>
        <dt>Engineer</dt><dd>${assign}${c.agent ? ` <button class="link" data-board-top="${esc(c.id)}">Move to top</button>` : ""}</dd>
        ${c.state ? `<dt>Linear</dt><dd>${esc(c.state)}</dd>` : ""}
        ${c.milestone ? `<dt>Milestone</dt><dd>${esc(c.milestone)}</dd>` : ""}
        ${c.labels.length ? `<dt>Labels</dt><dd class="bp-labs">${c.labels.map(lab).join("")}</dd>` : ""}
      </dl>
      ${c.status ? `<div class="bp-status"><b>${esc(who ?? c.status.by)} says</b><p>${esc(c.status.note)}</p>${c.status.blocked ? `<p class="bp-blocked">Blocked on ${esc(c.status.blocked)}</p>` : ""}<time>${when(c.status.at)}</time></div>` : ""}
      <h3>Work</h3><div class="bp-works">${work}</div>
      ${hist ? `<h3>History</h3><ul class="bp-hist">${hist}</ul>` : ""}
    </div></aside>`;
}

export function boardView(): string {
  const b: BoardData | null = S.board;
  if (!b) return `<div class="pane-body"><div class="blank"><p>${S.boardError ? esc(S.boardError) : "Loading the Board…"}</p></div></div>`;
  const list = shown(b.cards);
  const eng = engineers(b.cards);
  const f = S.boardFilter;
  const shownEng = f.agent ? eng.filter((e) => e.name === f.agent) : eng;
  const pile = (n: string) => list.filter((c) => c.agent === n && c.stage !== "done").sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
  let main: string;
  // Each pile reads top down: what the engineer is on Now, what needs you or is blocked, what is in
  // review, then what is up next. An engineer with no Now says how long it has been idle.
  const onYou = (c: Card) => /pratik|\byou\b/i.test(c.status?.blocked ?? "");
  const GROUPS: [string, (c: Card) => boolean][] = [["Needs you", (c) => c.stage === "you"], ["Blocked on you", (c) => c.stage === "blocked" && onYou(c)],
    ["Blocked", (c) => c.stage === "blocked" && !onYou(c)],
    ["In review", (c) => ["review", "changes", "approved", "merging"].includes(c.stage)], ["Checking", (c) => c.stage === "checking"], ["Up next", (c) => c.stage === "next"]];
  const since = (iso: string | null) => (iso ? when(iso) : "");
  if (S.boardView === "piles") {
    main = `<section class="bpiles">${shownEng.map((e) => {
      const p = pile(e.name);
      const now = p.find((c) => c.now);
      const rest = p.filter((c) => c !== now);
      const lastWord = p.map((c) => c.last_word).filter(Boolean).sort().at(-1) as string | undefined;
      // No Now, but waiting on something: say what it waits on, not "idle" (what the person reads).
      const waiting = !now ? p.filter((c) => c.stage === "blocked" || c.stage === "you").sort((x, y) => (y.last_word ?? "").localeCompare(x.last_word ?? ""))[0] : undefined;
      const sub = now ? `Now: ${esc(now.id)} · last word ${since(now.last_word)}`
        : waiting ? `<span class="bwait">Waiting: ${esc(waiting.id)}${waiting.status?.blocked ? `, blocked on ${esc(waiting.status.blocked)}` : waiting.stage === "you" ? ", needs you" : ""}</span>`
        : `<span class="bidle">Idle${lastWord || e.last ? ` since ${since(lastWord ?? e.last)}` : ""}</span>`;
      const groups = GROUPS.map(([name, f]) => { const cs = rest.filter(f); return cs.length ? `<h4 class="bgh">${name} <i>${cs.length}</i></h4>${cs.map((c) => card(c, null)).join("")}` : ""; }).join("");
      return `<div class="bpile bcol" data-drop="${esc(e.name)}"><header>${mark(e.name, "sm")}<div><b>${esc(e.label)}</b><span>${sub}</span></div><i>${p.length}</i></header>
        <div class="bpl">${now ? card(now, null) : ""}${groups || (now ? "" : `<p class="bempty">Drop a ticket here</p>`)}</div></div>`;
    }).join("")}</section>`;
  } else {
    const inPiles = list.filter((c) => c.agent && c.stage !== "done" && (!f.agent || c.agent === f.agent));
    const label = (n: string) => eng.find((e) => e.name === n)?.label ?? n;
    const cols: [string, string, Card[]][] = [["now", "Now", inPiles.filter((c) => c.now)], ...STAGES.filter(([k]) => k !== "next").map(([k, n]) => [k, n, inPiles.filter((c) => !c.now && c.stage === k)] as [string, string, Card[]]),
      ["next", "Up next", inPiles.filter((c) => !c.now && c.stage === "next")]];
    main = `<section class="bpiles">${cols.map(([k, name, cs]) => cs.length ? `<div class="bpile"><header>${k === "now" ? `<span class="bnow">Now</span>` : glyph(k)}<div><b>${name}</b></div><i>${cs.length}</i></header><div class="bpl">${cs.map((c) => card(c, label(c.agent!))).join("")}</div></div>` : "").join("")
      || `<p class="bempty">Nothing in a pile yet. Drag a ticket from the backlog onto an engineer.</p>`}</section>`;
  }
  const open = S.boardOpen ? b.cards.find((c) => c.id === S.boardOpen) : null;
  const synced = b.linear.connected ? `Linear synced ${b.synced_at ? when(b.synced_at) : "not yet"} · <button class="link" data-board-sync>Refresh</button> · <button class="link" data-linear-disconnect>Disconnect</button>` : "";
  return `<div class="pane-body board-page">${connectBox(b)}${bar(b, eng)}
    <div class="bbody ${open ? "with-panel" : ""}">${backlogPane(list)}${main}${open ? panel(open, eng) : ""}</div>
    ${synced ? `<p class="bfoot">${synced}</p>` : ""}</div>`;
}

export const boardSub = () => {
  const b: BoardData | null = S.board;
  if (!b) return "";
  return `${b.cards.filter((c) => !c.agent && c.stage !== "done").length} in backlog · ${b.cards.filter((c) => c.agent && c.stage !== "done").length} in piles`;
};

// Drag and drop: where a card lands in a pile is "before" the card under the pointer.
let dragging: string | null = null;
export function wireBoardDrag(onDrop: (task: string, agent: string | null, before: string | null) => void) {
  document.addEventListener("dragstart", (e) => {
    const c = (e.target as HTMLElement).closest?.<HTMLElement>("[data-card]");
    if (!c || !c.closest(".board-page")) return;
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
