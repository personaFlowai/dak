/* The Team page: everyone who works through Dak, on this Mac or outside it, with the card the
   person keeps for each (name, role, area, what it can and cannot do), and the door that lets
   agents outside this Mac in, one key each. */
import { S, esc, mark, when, me } from "./state";
import { api } from "./api";
import { I } from "./icons";
import type { TeamMember } from "../src/team";

export async function loadTeam() {
  try { S.team = await api<TeamMember[]>("/team"); } catch { /* the page says it could not load */ }
}

const KIND: Record<string, string> = { person: "You", local: "On this Mac", cloud: "Outside, through the door", bot: "Bot" };
const TOOL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", grok: "Grok Bot", http: "HTTPS", cli: "Command line" };

function card(m: TeamMember): string {
  const editing = S.teamEdit === m.name;
  const where = [KIND[m.kind] ?? m.kind, m.tool ? TOOL[m.tool] ?? m.tool : "", m.via ? `speaks through ${esc(m.via)}` : ""].filter(Boolean).join(" · ");
  const seen = m.listening ? `<span class="live" title="Used Dak in the last 10 minutes">Listening</span>` : m.last_seen ? `<span>Seen ${when(m.last_seen)}</span>` : "";
  const head = `<div class="tm-head">${mark(m.name, "md")}<div class="tm-name"><b>${esc(m.display || m.name)}</b><span><code>@${esc(m.name)}</code> · ${where}</span></div>${seen}
    ${m.kind === "person" ? "" : `<button class="btn subtle" data-team-edit="${esc(m.name)}">${editing ? "Cancel" : "Edit"}</button>`}</div>`;
  if (editing) {
    const f = (k: "display" | "role" | "area" | "can" | "cannot", label: string, ph: string) =>
      `<label class="tm-field"><span>${label}</span><input class="input" data-team-field="${k}" value="${esc(m[k] ?? "")}" placeholder="${esc(ph)}" maxlength="200"></label>`;
    return `<li class="tm editing">${head}<div class="tm-form">${f("display", "Name", "Atlas")}${f("role", "Role", "CTO")}${f("area", "Area", "Engineering, the merge queue")}
      ${f("can", "Can", "writes code in jewel-saas, merges")}${f("cannot", "Cannot", "no production access")}
      <div class="btns"><button class="btn primary" data-team-save="${esc(m.name)}">Save</button></div></div></li>`;
  }
  const facts = [m.role || m.area ? `<p class="tm-role">${esc([m.role, m.area].filter(Boolean).join(" · "))}</p>` : "",
    m.can ? `<p class="tm-can"><b>Can</b> ${esc(m.can)}</p>` : "", m.cannot ? `<p class="tm-can"><b>Cannot</b> ${esc(m.cannot)}</p>` : ""].join("");
  return `<li class="tm">${head}${facts || (m.kind === "person" ? "" : `<p class="tm-empty">No card yet. Edit to say what ${esc(m.name)} does, so work and @mentions reach the right one.</p>`)}</li>`;
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
    ${doorSection()}</div></div>`;
}

export const teamCount = () => (S.team ?? []).filter((m) => m.name !== me).length;
