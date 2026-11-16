/* A PR on a phone. Three tabs: Overview, Guide (every chapter in one scroll, each with its
   files and a box to tick each one off) and Diff (every file). A file opens as a sheet over the
   page with its diff; closing it puts you back where you were, never at the top. */
import { S, esc, chaptersOf, viewed, type Pr } from "./state";
import { hunkStart, type DiffFile } from "../src/diff";
import type { Chapter } from "../src/types";
import { I } from "./icons";

export type PhoneTab = "overview" | "guide" | "diff";

// Which hunks of which files a chapter covers. A concept chapter (key changes only) covers
// the hunks its key changes point into.
export function chapterHunks(ch: Chapter, files: DiffFile[]): Map<string, number[]> {
  const by = new Map<string, number[]>();
  for (const h of ch.hunks) by.set(h.file, [...(by.get(h.file) ?? []), h.start]);
  if (!ch.hunks.length) for (const k of ch.key_changes ?? []) {
    const f = files.find((x) => x.path === k.file);
    const side = k.side ?? "new";
    const h = f?.hunks.find((x) => side === "old" ? k.line >= x.old_start && k.line < x.old_start + Math.max(x.old_lines, 1) : k.line >= x.new_start && k.line < x.new_start + Math.max(x.new_lines, 1));
    if (f && h && !(by.get(f.path) ?? []).includes(hunkStart(f, h))) by.set(f.path, [...(by.get(f.path) ?? []), hunkStart(f, h)]);
  }
  return by;
}

function counts(f: DiffFile | undefined, starts?: number[]) {
  let add = 0, del = 0;
  for (const h of f?.hunks ?? []) if (!starts || starts.includes(hunkStart(f!, h))) for (const l of h.lines) { if (l[0] === "+") add++; else if (l[0] === "-") del++; }
  return `${add ? `<span class="a">+${add}</span>` : ""}${del ? ` <span class="d">−${del}</span>` : ""}`;
}

function fileRows(a: Pr, files: DiffFile[], by: Map<string, number[]> | null, chapter: number): string {
  const seen = viewed(a.id);
  const paths = by ? [...by.keys()] : files.map((f) => f.path);
  return `<div class="pf-card">${paths.map((path) => {
    const slash = path.lastIndexOf("/");
    return `<div class="pf-row"><button class="pf-open" data-phone-file="${esc(path)}" data-ch="${chapter}"><b>${esc(path.slice(slash + 1))}</b><span>${esc(slash >= 0 ? path.slice(0, slash) : "")}</span></button>
      <span class="n">${counts(files.find((f) => f.path === path), by?.get(path))}</span>
      <input type="checkbox" data-viewed="${esc(path)}" aria-label="Reviewed ${esc(path)}" ${seen.has(path) ? "checked" : ""}></div>`;
  }).join("")}</div>`;
}

export function phoneTabs(a: Pr, plain: boolean): string {
  const add = a.meta.files.reduce((n, f) => n + f.additions, 0), del = a.meta.files.reduce((n, f) => n + f.deletions, 0);
  const tab = (k: PhoneTab, label: string) => `<button class="ptab ${S.phoneTab === k ? "on" : ""}" data-phone-tab="${k}">${label}</button>`;
  return `<nav class="ptabs">${tab("overview", "Overview")}${plain ? "" : tab("guide", "Guide")}${tab("diff", `Diff <span class="a">+${add}</span> <span class="d">−${del}</span>`)}</nav>`;
}

export function phoneGuide(a: Pr, files: DiffFile[], done: Set<number>): string {
  const chapters = chaptersOf(a);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `<div class="pguide">${chapters.map((c, i) => `<section class="pch">
    <div class="pch-meta"><span>${pad(i + 1)} / ${pad(chapters.length)}</span>
      <label class="viewed-box"><input type="checkbox" data-chapter-reviewed="${i}" ${done.has(i) ? "checked" : ""}> Reviewed</label></div>
    <h2>${esc(c.title)}</h2>
    ${c.summary ? `<p>${esc(c.summary)}</p>` : ""}${c.why ? `<p class="why">${esc(c.why)}</p>` : ""}
    ${c.risk !== "low" && c.risk_why ? `<p class="prisk"><span class="risk ${c.risk}">${c.risk === "high" ? "High risk" : "Medium risk"}</span> ${esc(c.risk_why)}</p>` : ""}
    ${fileRows(a, files, chapterHunks(c, files), i)}</section>`).join("")}</div>`;
}

export const phoneDiff = (a: Pr, files: DiffFile[]) => `<div class="pguide">${fileRows(a, files, null, -1)}</div>`;

// The sheet: the chapter it came from, the file, and its diff, over the page.
export function phoneSheet(a: Pr, files: DiffFile[], done: Set<number>, fileSection: (a: Pr, df: DiffFile | undefined, path: string, starts: number[]) => string): string {
  const path = S.phoneFile!;
  const chapters = chaptersOf(a);
  const ch = S.phoneFileChapter >= 0 ? chapters[S.phoneFileChapter] : null;
  const f = files.find((x) => x.path === path);
  const starts = ch ? chapterHunks(ch, files).get(path) ?? [] : (f?.hunks ?? []).map((h) => hunkStart(f!, h));
  S.unfold.add(`${a.id}:${path}`);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `<div class="psheet" role="dialog" aria-label="${esc(path)}">
    <header class="psheet-top"><div>${ch ? `<b>${esc(ch.title)}</b><div class="pch-meta"><span>${pad(S.phoneFileChapter + 1)} / ${pad(chapters.length)}</span>
      <label class="viewed-box"><input type="checkbox" data-chapter-reviewed="${S.phoneFileChapter}" ${done.has(S.phoneFileChapter) ? "checked" : ""}> Reviewed</label></div>` : `<b>All changes</b>`}</div>
      <button class="icon-btn psheet-x" data-phone-file="" aria-label="Close">${I.close}</button></header>
    <div class="psheet-body">${fileSection(a, f, path, starts)}</div></div>`;
}
