/* New agent: a panel that slides in from the right, from the Team page or from a piece of work.
   Like adding someone to the team: a name, the engine it runs on, the folder it works in, an
   optional piece of work, and the first message. The folder starts on a new worktree off main in
   the repository used last, so most starts are a name, a message and Start. Dak refuses while the
   machine is busy, and says so before anyone presses Start. */
import { api } from "./api";
import { esc, me } from "./state";
import { I, TOOLS } from "./icons";
import { P } from "./places";

export interface LaunchInfo { load: { now: number; limit: number; ok: boolean }; repos: string[]; folders: { path: string; name: string; last_seen: string }[] }
export const L = {
  open: false, info: null as LaunchInfo | null,
  tool: "claude-code", name: "", repo: "", folder: "", other: false, work: "", message: "", error: "", sending: false,
};

export async function loadLaunch() {
  try { L.info = await api<LaunchInfo>("/launch"); } catch { L.info = null; }
  if (!L.repo && !L.folder && L.info?.repos[0]) L.repo = L.info.repos[0];
}

// Open the panel: empty from the Team page, or with a piece of work already attached.
export async function openLaunch(work = "") {
  Object.assign(L, { open: true, work, name: "", message: "", error: "", other: false, folder: "" });
  await loadLaunch();
}
export const closeLaunch = () => { L.open = false; L.error = ""; };

// Typed values survive a redraw (picking an engine or a folder redraws the panel).
export function keepLaunchFields() {
  const v = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value;
  L.name = v("l-name") ?? L.name; L.message = v("l-message") ?? L.message;
  const path = v("l-path"); if (path !== undefined && L.other) L.folder = path;
  const work = v("l-work"); if (work !== undefined) L.work = work;
}

const short = (path: string) => path.split("/").pop() ?? path;
const ago = (iso: string) => { const h = (Date.now() - Date.parse(iso)) / 3_600_000; return h < 1 ? "now" : h < 24 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`; };

export function launchPanel(): string {
  if (!L.open) return "";
  const info = L.info;
  const w = P.work.find((x) => x.id === L.work);
  const engines = (["claude-code", "codex", "cursor"] as const).map((t) =>
    `<button type="button" class="eng ${L.tool === t ? "on" : ""}" data-l-tool="${t}" aria-pressed="${L.tool === t}"><span class="mark sm">${TOOLS[t].mark}</span>${TOOLS[t].label}</button>`).join("");
  const tick = (on: boolean) => `<span class="tick">${on ? I.check : ""}</span>`;
  const repos = (info?.repos ?? []).map((r, i) => `<button type="button" class="fo ${!L.other && L.repo === r ? "on" : ""}" data-l-repo="${esc(r)}">
    <span class="ic">${I.pr}</span><span class="nm"><b>${esc(short(r))}</b><span>A new worktree off main</span></span><span class="r">${i === 0 ? "used last" : ""}</span>${tick(!L.other && L.repo === r)}</button>`).join("");
  const others = L.other ? `<div class="fo-other">${(info?.folders ?? []).slice(0, 6).map((f) => `<button type="button" class="fo ${L.folder === f.path ? "on" : ""}" data-l-folder="${esc(f.path)}">
      <span class="ic">${I.doc}</span><span class="nm"><b>${esc(short(f.path))}</b><span>${esc(f.name)} · ${ago(f.last_seen)}</span></span>${tick(L.folder === f.path)}</button>`).join("")}
    <input class="input" id="l-path" value="${esc(L.folder)}" placeholder="Or type a folder's path" autocomplete="off" spellcheck="false"></div>` : "";
  const open = P.work.filter((x) => x.state !== "done" && !x.from_board);
  const work = w ? `<div class="workchip"><span class="mark sm">${I.stack}</span><span class="nm"><b>${esc(w.id)} · ${esc(w.title)}</b><span>${esc(w.kind)}${w.ticket ? ` · ${esc(w.ticket)}` : ""} · ${esc(w.stage)}</span></span><button type="button" class="icon-btn" data-l-work="" aria-label="Remove">${I.close}</button></div>`
    : `<select class="input" id="l-work" aria-label="A piece of work"><option value="">No piece of work</option>${open.map((x) => `<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.title.slice(0, 70))}</option>`).join("")}</select>`;
  const load = info ? `<span class="lload ${info.load.ok ? "" : "busy"}">${I.check}Load ${info.load.now} of ${info.load.limit}${info.load.ok ? "" : ": wait until the machine is less busy"}</span>` : "";
  return `<div class="lscrim"><aside class="lsheet" role="dialog" aria-label="New agent">
    <header><b>${w ? `Start a new agent on ${esc(w.id)}` : "New agent"}</b><span class="grow"></span><button type="button" class="icon-btn" data-l-close aria-label="Close">${I.close}</button></header>
    <div class="lbody">
      <div class="field"><label for="l-name">Name</label><input class="input" id="l-name" value="${esc(L.name)}" placeholder="What it does, e.g. Designer" autocomplete="off" spellcheck="false">
        <p class="lhint">It joins the Team under this name. A name already on the team adds a session to that agent instead.</p></div>
      <div class="field"><label>Engine</label><div class="engines">${engines}</div></div>
      <div class="field"><label>Folder</label><div class="folder">${repos}
        <button type="button" class="fo ${L.other ? "on" : ""}" data-l-other><span class="ic">${I.doc}</span><span class="nm"><b>Another folder…</b><span>An existing folder or worktree</span></span>${tick(L.other)}</button></div>${others}</div>
      <div class="field"><label${w ? "" : ` for="l-work"`}>Work${w ? "" : ` <span class="lopt">optional</span>`}</label>${work}</div>
      <div class="field"><label for="l-message">First message</label>
        <textarea class="input" id="l-message" rows="4" placeholder="${w ? esc(`Start on ${w.id}: ${w.title}.`) : "What should it do first?"}">${esc(L.message)}</textarea></div>
      ${L.error ? `<p class="err">${esc(L.error)}</p>` : ""}
    </div>
    <footer>${load}<span class="grow"></span><button type="button" class="btn" data-l-close>Cancel</button>
      <button type="button" class="btn primary" data-l-start ${L.sending || (info && !info.load.ok) ? "disabled" : ""}>${L.sending ? "Starting" : "Start"}</button></footer>
  </aside></div>`;
}

// The fields are read by the caller before it redraws the panel (keepLaunchFields), not here.
export async function submitLaunch(): Promise<{ thread_id: string } | null> {
  L.error = "";
  if (!L.name.trim()) { L.error = "Give it a name."; return null; }
  if (L.other && !L.folder.trim()) { L.error = "Pick a folder, or type its path."; return null; }
  L.sending = true;
  try {
    const r = await api<{ thread_id: string }>("/launch", { method: "POST", body: { tool: L.tool, name: L.name, message: L.message, by: me,
      repo: L.other ? null : L.repo || null, folder: L.other ? L.folder : null, work: L.work || null } });
    closeLaunch();
    return r;
  } catch (e: any) { L.error = e.message ?? "Could not start it."; return null; }
  finally { L.sending = false; }
}
