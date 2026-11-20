/* From Linear, on the Work page: the issues that are not work yet, grouped by milestone, each
   with "Make work". Made work lands in Not started with no owner; assign it from its card. */
import { api } from "./api";
import { esc, me } from "./state";
import { I } from "./icons";

export interface Issue { id: string; title: string; state: string | null; milestone: string | null; labels: string[]; url: string | null }
export const FL = { open: false, issues: [] as Issue[], q: "", made: {} as Record<string, string>, error: "", syncing: false };

export async function loadIssues() { try { FL.issues = await api<Issue[]>("/linear/issues"); FL.error = ""; } catch (e: any) { FL.error = e.message; } }

export async function makeWork(id: string) {
  try { const w = await api<{ id: string }>(`/linear/issues/${encodeURIComponent(id)}`, { method: "POST", body: { by: me } }); FL.made[id] = w.id; }
  catch (e: any) { FL.error = e.message ?? "Could not make it work."; }
}
export async function syncLinear() { FL.syncing = true; try { await api("/board/sync", { method: "POST", body: {} }); await loadIssues(); } finally { FL.syncing = false; } }

export function linearButton(): string {
  const n = FL.issues.filter((i) => !FL.made[i.id]).length;
  return `<button class="btn ${FL.open ? "on" : ""}" data-fl-toggle aria-expanded="${FL.open}">${I.stack}From Linear${n ? ` <span class="fl-n">${n}</span>` : ""}</button>`;
}

export function linearPanel(): string {
  if (!FL.open) return "";
  const q = FL.q.trim().toLowerCase();
  const list = FL.issues.filter((i) => !q || `${i.id} ${i.title} ${i.milestone ?? ""}`.toLowerCase().includes(q));
  const groups = new Map<string, Issue[]>();
  for (const i of list) groups.set(i.milestone ?? "No milestone", [...(groups.get(i.milestone ?? "No milestone") ?? []), i]);
  const rows = [...groups].map(([m, is]) => `<div class="fl-grp">${esc(m)} <i>${is.length}</i></div>${is.slice(0, 60).map((i) => `<div class="fl-row">
      <div class="nm"><b title="${esc(i.title)}">${esc(i.title)}</b><span>${esc(i.id)}${i.state ? ` · ${esc(i.state)}` : ""}</span></div>
      ${FL.made[i.id] ? `<button class="fl-made" data-work-open="${esc(FL.made[i.id])}">${esc(FL.made[i.id])} made</button>` : `<button class="btn" data-fl-make="${esc(i.id)}">Make work</button>`}</div>`).join("")}`).join("");
  return `<aside class="wpanel fl" role="dialog" aria-label="From Linear"><header><b>From Linear</b><span class="fl-sub">issues that are not work yet</span><span class="grow"></span>
      <button class="icon-btn" data-fl-sync title="Sync from Linear" aria-label="Sync from Linear" ${FL.syncing ? "disabled" : ""}>${I.lineUp}</button><button class="icon-btn" data-fl-toggle aria-label="Close">${I.close}</button></header>
    <div class="fl-find"><input id="fl-q" type="search" placeholder="Find an issue" value="${esc(FL.q)}" autocomplete="off"></div>
    ${FL.error ? `<p class="err" style="margin:0 16px">${esc(FL.error)}</p>` : ""}
    <div class="fl-list">${rows || `<p class="wb-empty" style="margin:12px 16px">${FL.issues.length ? "Nothing matches." : "Every open Linear issue is already work, or Linear is not connected (Settings)."}</p>`}</div>
    <footer class="fl-foot">Make work puts it in Not started, not assigned, with the issue as its ticket. Assign it from its card.</footer></aside>`;
}
