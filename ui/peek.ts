/* The peek: ⌘-click a name in a PR's code and its definition opens in a panel over the code,
   with the places that use it. ⌘-click inside the peek goes one step further; Back returns.
   A place in the PR's own diff scrolls the PR there; anything else opens in the peek. */
import { S, esc } from "./state";
import { api } from "./api";
import { highlightLines } from "./hl";
import { I } from "./icons";
import type { Lookup, Snippet, Spot } from "../src/lookup";

export interface Peek { name: string; loading: boolean; error?: string; data?: Lookup; def: number; showing?: Snippet; refsOpen: boolean }

// The identifier under a click, whole: "saveTask" from anywhere inside it.
export function wordAt(x: number, y: number): string | null {
  const r = (document as any).caretRangeFromPoint?.(x, y) as Range | null;
  const n = r?.startContainer;
  if (!r || !n || n.nodeType !== Node.TEXT_NODE) return null;
  const t = n.textContent ?? "";
  let i = r.startOffset, j = r.startOffset;
  while (i > 0 && /[\w$]/.test(t[i - 1])) i--;
  while (j < t.length && /[\w$]/.test(t[j])) j++;
  const w = t.slice(i, j);
  return /^[A-Za-z_$][\w$]*$/.test(w) && !KEYWORDS.has(w) ? w : null;
}
const KEYWORDS = new Set("const let var function return if else for while do switch case break continue new this class extends import export from default async await try catch finally throw typeof instanceof in of true false null undefined void type interface enum public private protected static readonly def self None True False and or not".split(" "));

export async function openPeek(name: string, rerender: () => void) {
  if (!S.cur || !S.att) return;
  if (S.peek && !S.peek.loading) S.peekBack.push(S.peek);
  S.peek = { name, loading: true, def: 0, refsOpen: false };
  rerender();
  try {
    const data = await api<Lookup>(`/lookup?thread=${encodeURIComponent(S.cur)}&att=${encodeURIComponent(S.att)}&name=${encodeURIComponent(name)}`);
    if (S.peek?.name === name) S.peek = { ...S.peek, loading: false, data, refsOpen: !data.defs.length };
  } catch (e: any) {
    if (S.peek?.name === name) S.peek = { ...S.peek, loading: false, error: e?.message ?? "Could not look that up." };
  }
  rerender();
}

export async function showSpot(file: string, line: number, rerender: () => void) {
  if (!S.peek || !S.cur || !S.att) return;
  try {
    const sn = await api<Snippet>(`/lookup?thread=${encodeURIComponent(S.cur)}&att=${encodeURIComponent(S.att)}&file=${encodeURIComponent(file)}&line=${line}`);
    S.peekBack.push({ ...S.peek });
    S.peek = { ...S.peek, showing: sn };
  } catch (e: any) { S.peek = { ...S.peek, error: e?.message ?? "Could not open that file." }; }
  rerender();
}

export function closePeek() { S.peek = null; S.peekBack = []; }
export function peekBackStep(): boolean { const p = S.peekBack.pop(); if (!p) return false; S.peek = p; return true; }

function code(sn: Snippet): string {
  const html = highlightLines(sn.lines.join("\n"), sn.file);
  return `<table class="peek-code"><tbody>${html.map((h, i) => {
    const n = sn.start + i;
    return `<tr class="${n === sn.at ? "at" : ""}"><td class="ln">${n}</td><td class="tx">${h || " "}</td></tr>`;
  }).join("")}</tbody></table>`;
}

const where = (s: { file: string; line: number; in_pr: boolean }) =>
  `<span class="pf">${esc(s.file)}</span><span class="pl">:${s.line}</span>${s.in_pr ? `<span class="inpr">In this PR</span>` : ""}`;

function refList(refs: Spot[], total: number): string {
  const rows = refs.map((r) => `<button class="pref" data-peek-at="${esc(r.file)}|${r.line}|${r.in_pr ? 1 : 0}">
    <span class="pw">${where(r)}</span><code>${esc(r.text.trim())}</code></button>`).join("");
  return `${rows}${total > refs.length ? `<p class="pmore">And ${total - refs.length} more.</p>` : ""}`;
}

export function peekView(): string {
  const p = S.peek!;
  const back = S.peekBack.length ? `<button class="icon-btn" data-peek-back title="Back (⌘[)" aria-label="Back">${I.prev}</button>` : "";
  const head = (sub: string) => `<header class="peek-top">${back}<div class="pt"><b><code>${esc(p.name)}</code></b><span>${sub}</span></div>
    <button class="icon-btn" data-peek-close title="Close (Esc)" aria-label="Close">${I.close}</button></header>`;
  if (p.loading) return `<aside class="peek">${head("Looking it up…")}</aside>`;
  if (p.error) return `<aside class="peek">${head("")}<p class="perr">${esc(p.error)}</p></aside>`;
  const d = p.data!;
  if (p.showing) return `<aside class="peek">${head(`${esc(p.showing.file)}:${p.showing.at}`)}<div class="peek-body">${code(p.showing)}</div></aside>`;
  const def = d.defs[p.def];
  const searched = d.searched === "head" ? "the repo at this PR's head" : d.searched === "worktree" ? "the repo as checked out here" : "this PR's files (no checkout here)";
  const sub = def ? `Defined in ${where(def)}` : `No definition found in ${searched}`;
  const pick = d.defs.length > 1 ? `<div class="pdefs">${d.defs.map((x, i) => `<button class="chip-f ${i === p.def ? "on" : ""}" data-peek-def="${i}">${esc(x.file.split("/").pop()!)}:${x.line}</button>`).join("")}</div>` : "";
  const body = def?.snippet ? code(def.snippet) : def ? `<p class="perr">${esc(def.text.trim())}</p>` : "";
  return `<aside class="peek">${head(sub)}${pick}<div class="peek-body">${body}
    <div class="prefs"><button class="tg fold" data-peek-refs aria-expanded="${p.refsOpen}">${I.next}<span>Used in ${d.refs_total} place${d.refs_total === 1 ? "" : "s"}</span></button>
      ${p.refsOpen ? refList(d.refs, d.refs_total) : ""}</div></div></aside>`;
}
