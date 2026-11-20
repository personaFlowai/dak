/* Stages, on the Rules page: the person's list for each kind of work, in order. Each stage has a
   name, what it counts as for Dak's rules, when a piece there is stuck, and (for code) which
   point in a PR's life brings a piece there by itself. Edited as a draft, saved together. */
import { api } from "./api";
import { esc, me } from "./state";
import { I } from "./icons";
import { WB, loadStages, type Stage } from "./workboard";

export const SE = { kind: "code", draft: null as Stage[] | null, error: "", saved: false };

const GATE: [Stage["gate"], string][] = [["start", "Waiting to start"], ["work", "Being worked on"], ["review", "Your review: needs proof and a briefing; only you move it on"], ["done", "Done: needs proof"]];
const PR: [string, string][] = [["", "Its owner moves it"], ["pr_open", "A PR is opened"], ["pr_proof", "The PR's proof is in"], ["pr_cursor", "Cursor reviews it"],
  ["pr_review", "It waits on you"], ["pr_merging", "It is merging"], ["pr_merged", "It is merged"]];
const KINDS = ["code", "mock", "research", "doc", "email", "note"];

const draft = () => (SE.draft ??= structuredClone(WB.stages[SE.kind] ?? []));

export function stagesEditor(): string {
  const list = draft();
  const row = (s: Stage, i: number) => `<div class="se-row">
    <span class="se-n">${i + 1}</span>
    <input class="input" data-se-name="${i}" value="${esc(s.name)}" maxlength="40" aria-label="Stage ${i + 1} name">
    <select class="input" data-se-gate="${i}" aria-label="Counts as">${GATE.map(([v, l]) => `<option value="${v}" ${s.gate === v ? "selected" : ""}>${l}</option>`).join("")}</select>
    <label class="se-stuck"><input class="input" data-se-stuck="${i}" type="number" min="1" value="${s.stuck_hours ?? ""}" placeholder="never" aria-label="Stuck after, hours"><span>h</span></label>
    ${SE.kind === "code" ? `<select class="input" data-se-pr="${i}" aria-label="Moves here by itself when">${PR.map(([v, l]) => `<option value="${v}" ${s.pr === v ? "selected" : ""}>${l}</option>`).join("")}</select>` : ""}
    <span class="se-acts"><button class="icon-btn" data-se-up="${i}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>${I.up}</button>
      <button class="icon-btn" data-se-del="${i}" aria-label="Remove" ${list.length <= 2 ? "disabled" : ""}>${I.close}</button></span></div>`;
  return `<h2>Stages <i>one column each on the Work board</i></h2>
    <div class="seg se-kinds" role="group" aria-label="Kind">${KINDS.map((k) => `<button data-se-kind="${k}" aria-pressed="${SE.kind === k}">${k.charAt(0).toUpperCase() + k.slice(1)}</button>`).join("")}</div>
    <div class="se ${SE.kind === "code" ? "code" : ""}"><div class="se-row head"><span>#</span><span>Stage</span><span>Counts as</span><span>Stuck after</span>${SE.kind === "code" ? "<span>Moves here by itself when</span>" : ""}<span></span></div>
      ${list.map(row).join("")}</div>
    ${SE.error ? `<p class="err">${esc(SE.error)}</p>` : ""}
    <div class="se-btns"><button class="btn" data-se-add>Add a stage</button><span class="grow"></span>${SE.saved ? `<span class="se-ok">${I.check}Saved</span>` : ""}
      <button class="btn" data-se-reset>Undo changes</button><button class="btn primary" data-se-save>Save stages</button></div>
    <p class="se-note">Whatever the names: a piece reaches your review only with proof and a topic that briefs it, only you move it on from there, and the last stage needs proof. Agents move their pieces with <code>dak work stage W-12 testing</code>.</p>`;
}

// Typed values survive a redraw.
export function keepStageFields() {
  const list = draft();
  document.querySelectorAll<HTMLInputElement>("[data-se-name]").forEach((el) => { list[Number(el.dataset.seName)].name = el.value; });
  document.querySelectorAll<HTMLSelectElement>("[data-se-gate]").forEach((el) => { list[Number(el.dataset.seGate)].gate = el.value as Stage["gate"]; });
  document.querySelectorAll<HTMLInputElement>("[data-se-stuck]").forEach((el) => { list[Number(el.dataset.seStuck)].stuck_hours = el.value ? Number(el.value) : null; });
  document.querySelectorAll<HTMLSelectElement>("[data-se-pr]").forEach((el) => { list[Number(el.dataset.sePr)].pr = el.value; });
}

export async function stageAction(d: DOMStringMap): Promise<boolean> {
  if (d.seKind) { SE.kind = d.seKind; SE.draft = null; SE.error = ""; SE.saved = false; return true; }
  if (d.seAdd === undefined && d.seUp === undefined && d.seDel === undefined && d.seReset === undefined && d.seSave === undefined) return false;
  keepStageFields(); SE.saved = false; SE.error = "";
  const list = draft();
  if (d.seAdd !== undefined) list.splice(Math.max(0, list.length - 1), 0, { name: "", gate: "work", stuck_hours: 24, pr: "" });
  if (d.seUp !== undefined) { const i = Number(d.seUp); [list[i - 1], list[i]] = [list[i], list[i - 1]]; }
  if (d.seDel !== undefined) list.splice(Number(d.seDel), 1);
  if (d.seReset !== undefined) SE.draft = null;
  if (d.seSave !== undefined) {
    try { await api(`/stages/${SE.kind}`, { method: "PUT", body: { stages: list, by: me } }); await loadStages(); SE.draft = null; SE.saved = true; }
    catch (e: any) { SE.error = e.message ?? "Could not save the stages."; }
  }
  return true;
}
