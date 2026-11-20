/* The Team page: everyone who works through Dak, on this Mac or outside it, with the card the
   person keeps for each (name, role, area, what it can and cannot do), and the door that lets
   agents outside this Mac in, one key each. */
import { S, esc, mark, when, me, name } from "./state";
import { api } from "./api";
import { I } from "./icons";
import type { TeamMember } from "../src/team";

// Today's characters each agent wrote into Dak and was handed: what it costs in tokens.
let today: Record<string, { wrote: number; read: number }> = {};
export async function loadTeam() {
  try { S.team = await api<TeamMember[]>("/team"); } catch { /* the page says it could not load */ }
  try {
    const day = new Date().toISOString().slice(0, 10);
    today = Object.fromEntries((await api<{ agent: string; day: string; wrote: number; read: number }[]>("/usage?days=1")).filter((u) => u.day === day).map((u) => [u.agent, u]));
  } catch { today = {}; }
}
const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);

const KIND: Record<string, string> = { person: "You", local: "On this Mac", cloud: "Outside, through the door", bot: "Bot" };
const TOOL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Bot", http: "HTTPS", cli: "Command line" };

function card(m: TeamMember): string {
  const editing = S.teamEdit === m.name;
  const where = [KIND[m.kind] ?? m.kind, m.tool ? TOOL[m.tool] ?? m.tool : "", m.via ? `speaks through ${esc(m.via)}` : ""].filter(Boolean).join(" · ");
  const seen = m.listening ? `<span class="live" title="Used Dak in the last 10 minutes">Listening</span>` : m.last_seen ? `<span>Seen ${when(m.last_seen)}</span>` : "";
  const head = `<div class="tm-head">${mark(m.name, "md")}<div class="tm-name"><b>${esc(m.display || m.name)}${m.lead ? ` <i class="tm-lead">Lead</i>` : ""}</b><span><code>@${esc(m.name)}</code> · ${where}</span></div>${seen}
    ${m.kind === "person" ? "" : `<button class="btn subtle" data-team-edit="${esc(m.name)}">${editing ? "Cancel" : "Edit"}</button>`}</div>`;
  if (editing) {
    const f = (k: "display" | "role" | "area" | "can" | "cannot", label: string, ph: string) =>
      `<label class="tm-field"><span>${label}</span><input class="input" data-team-field="${k}" value="${esc(m[k] ?? "")}" placeholder="${esc(ph)}" maxlength="200"></label>`;
    return `<li class="tm editing">${head}<div class="tm-form">${f("display", "Name", "Lead")}${f("role", "Role", "CTO")}${f("area", "Area", "Engineering, the merge queue")}
      ${f("can", "Can", "writes code in my-app, merges")}${f("cannot", "Cannot", "no production access")}
      <label class="tm-check"><input type="checkbox" data-team-lead ${m.lead ? "checked" : ""}><span><b>Lead</b>: hears when you assign tickets on the Board. One member at most.</span></label>
      <div class="btns"><button class="btn primary" data-team-save="${esc(m.name)}">Save</button></div></div></li>`;
  }
  const facts = [m.role || m.area ? `<p class="tm-role">${esc([m.role, m.area].filter(Boolean).join(" · "))}</p>` : "",
    m.can ? `<p class="tm-can"><b>Can</b> ${esc(m.can)}</p>` : "", m.cannot ? `<p class="tm-can"><b>Cannot</b> ${esc(m.cannot)}</p>` : ""].join("");
  const u = today[m.name];
  const cost = u && m.kind !== "person" ? `<p class="tm-cost">Today: wrote ${k(u.wrote)}, read ${k(u.read)} characters in Dak</p>` : "";
  return `<li class="tm">${head}${cost}${facts || (m.kind === "person" ? "" : `<p class="tm-empty">No card yet. Edit to say what ${esc(m.name)} does, so work and @mentions reach the right one.</p>`)}${seatList(m)}</li>`;
}

// Its sessions this week. Two at once used to show as two members; they are one member's seats.
const SEAT_WORD = { working: "Working", open: "Open, idle", closed: "Closed" } as const;
function seatList(m: TeamMember): string {
  if (m.kind === "person" || !m.seats?.length) return "";
  return `<ul class="tm-seats">${m.seats.map((x) => `<li><i class="st ${x.state}"></i><code>${esc(x.where?.split("/").pop() ?? x.session_id.slice(0, 8))}</code>
    <span>${SEAT_WORD[x.state]}</span><time>${x.state === "working" ? "now" : when(x.last_seen)}</time></li>`).join("")}</ul>`;
}

// Groups: a conversation with several agents at once. Who is woken follows the @mentions.
function groupsSection(agents: TeamMember[]): string {
  const rows = Object.entries(S.groups).map(([g, ms]) => `<li class="grp-row">${mark(`group:${g}`, "md")}<span class="nm"><b>${esc(name(`group:${g}`))}</b><span>${ms.map((m) => esc(name(m))).join(", ")}</span></span>
    <button class="btn" data-group-open="${esc(g)}">Open</button></li>`).join("");
  const n = S.groupNew;
  const form = n ? `<div class="grp-form">
    <label class="tm-field"><span>Name</span><input class="input" id="group-name" value="${esc(n.name)}" placeholder="For example, engine-team" maxlength="40" autocomplete="off" spellcheck="false"></label>
    <div class="tm-field"><span>Members</span><div class="grp-pick">${agents.map((a) => `<button type="button" class="grp-chip" data-group-member="${esc(a.name)}" aria-pressed="${n.members.includes(a.name)}">${mark(a.name, "sm")}${esc(a.display || a.name)}</button>`).join("")}</div></div>
    <ul class="grp-rules"><li><b>@name</b> wakes only that member. A message with no @mention wakes nobody.</li><li>Everyone else sees one line per message at their next turn, not the full text.</li></ul>
    ${n.error ? `<p class="err">${esc(n.error)}</p>` : ""}
    <div class="btns"><button class="btn" data-group-new>Cancel</button><button class="btn primary" data-group-create>Create group</button></div></div>` : "";
  return `<section><h2>Groups</h2><p class="lead">Talk to several agents in one conversation.</p>
    ${rows ? `<ul class="grp-list">${rows}</ul>` : ""}${form || `<div class="btns"><button class="btn" data-group-new>New group</button></div>`}</section>`;
}

// The door: one public HTTPS address for every agent outside this Mac, each with its own key.
function doorSection(): string {
  const d = S.door ?? {};
  const agents: string[] = d.agents ?? [];
  const status = d.open && d.url ? `Open at <code>${esc(d.url)}</code>. The address changes if the door restarts.`
    : d.error ? esc(d.error) : "Closed. Opening it starts a tunnel to Dak; each agent gets a key that lets it write to you and the team, and read only its own topics.";
  const rows = agents.map((a) => `<li class="door-agent"><code>@${esc(a)}</code><span class="grow"></span>
    <button class="btn" data-door-show="${esc(a)}" ${d.open ? "" : "disabled"}>${d.for === a && d.instructions ? "Showing setup" : "Setup"}</button>
    <button class="link" data-door-rotate="${esc(a)}" title="A new key; the old one stops working">New key</button>
    <button class="link" data-door-revoke="${esc(a)}" title="Its key stops working">Remove</button></li>`).join("");
  const setup = d.open && d.instructions && d.for ? `<div class="door"><p class="lead">Paste this into ${esc(d.for)}'s instructions once.</p><pre id="door-text">${esc(d.instructions)}</pre>
    <div class="btns"><button class="btn" data-copy-door>Copy setup</button></div></div>` : "";
  return `<section><h2>Agents outside this Mac</h2>
    <div class="conn"><span class="mark md">${I.plug}</span><span class="nm"><b>The door</b><span>${status}</span></span>
      ${d.open ? `<button class="btn" data-door="close">Close door</button>` : `<button class="btn primary" data-door="open">${d.opening ? "Opening" : "Open door"}</button>`}</div>
    ${agents.length ? `<ul class="door-agents">${rows}</ul>` : ""}
    <div class="door-add"><input class="input" id="door-new" placeholder="Name for a new agent, e.g. codex-cloud" maxlength="40" autocomplete="off" spellcheck="false"><button class="btn" data-door-add>Add agent</button></div>
    ${setup}</section>`;
}

export function teamView(): string {
  const list: TeamMember[] = S.team ?? [];
  const people = list.filter((m) => m.kind === "person");
  const others = list.filter((m) => m.kind !== "person");
  return `<div class="pane-body"><div class="settings team-page">
    <section><h2>Team</h2><p class="lead">Everyone who works through Dak. Write <code>@name</code> in any message to bring them onto that topic. Agents read these cards (<code>dak team</code>) to send work to the right one.</p>
      <ul class="team-list">${[...people, ...others].map(card).join("") || `<li class="tm-empty">Nobody yet.</li>`}</ul></section>
    ${groupsSection(others)}
    ${doorSection()}</div></div>`;
}

export const teamCount = () => (S.team ?? []).filter((m) => m.name !== me).length;
