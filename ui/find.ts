/* Find in a PR: every file in its diff, whichever chapter it sits in and whether or not
   it is marked Reviewed. A match is a line of the diff (added, removed or context) or a
   file's name; picking one opens its chapter and puts the line in view. */
import { S, esc, chaptersOf, type Pr } from "./state";
import { hunkStart } from "../src/diff";
import { I } from "./icons";

export interface Hit { file: string; side: "old" | "new"; line: number; text: string; chapter: number; kind: " " | "+" | "-" | "name" }

const MAX = 500;

export function findHits(a: Pr, q: string): Hit[] {
  const query = q.trim().toLowerCase();
  if (query.length < 2) return [];
  const files = S.diffs.get(a.meta.diff_blob) ?? [];
  const chapters = chaptersOf(a);
  const chapterOf = (file: string, start: number) => chapters.findIndex((c) => c.hunks.some((h) => h.file === file && h.start === start));
  const hits: Hit[] = [];
  for (const f of files) {
    const first = f.hunks[0];
    if (f.path.toLowerCase().includes(query) && first) {
      hits.push({ file: f.path, side: "new", line: first.new_start, text: f.path, chapter: chapterOf(f.path, hunkStart(f, first)), kind: "name" });
    }
    for (const h of f.hunks) {
      const chapter = chapterOf(f.path, hunkStart(f, h));
      let o = h.old_start, n = h.new_start;
      for (const l of h.lines) {
        const c = l[0];
        if (c === "\\") continue;
        if (l.slice(1).toLowerCase().includes(query)) {
          hits.push({ file: f.path, side: c === "-" ? "old" : "new", line: c === "-" ? o : n, text: l.slice(1).trim(), chapter, kind: c as Hit["kind"] });
          if (hits.length >= MAX) return hits;
        }
        if (c !== "+") o++;
        if (c !== "-") n++;
      }
    }
  }
  return hits;
}

export const hitKey = (h: Hit) => `${h.file}|${h.side}|${h.line}`;

// The bar under the PR's title, and while you type, the list of matches.
export function findBar(hits: Hit[]): string {
  const f = S.find;
  const q = f.q.trim().toLowerCase();
  const count = q.length < 2 ? "" : hits.length ? `${f.i + 1} of ${hits.length}${hits.length >= MAX ? "+" : ""}` : "No matches";
  const mark = (t: string) => {
    const i = t.toLowerCase().indexOf(q);
    return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
  };
  const list = f.list && hits.length ? `<div class="find-results" role="listbox">${hits.slice(0, 200).map((h, i) => {
    const name = h.file.split("/").pop();
    return `<button class="hit ${i === f.i ? "on" : ""}" data-hit="${i}" role="option"><span class="where">${esc(name!)}${h.kind === "name" ? "" : `:${h.line}`}${h.kind === "-" ? " removed" : ""}</span><span class="snip ${h.kind === "+" ? "a" : h.kind === "-" ? "d" : ""}">${mark(h.kind === "name" ? h.file : h.text.slice(0, 160))}</span></button>`;
  }).join("")}</div>` : "";
  return `<div class="findbar">${I.search}<input id="find" value="${esc(f.q)}" placeholder="Find in this PR" autocomplete="off" spellcheck="false">
    <span class="count">${count}</span>
    <button class="icon-btn" data-find-step="-1" title="Previous (⇧↩)" aria-label="Previous match" ${hits.length ? "" : "disabled"}>${I.prev}</button>
    <button class="icon-btn" data-find-step="1" title="Next (↩)" aria-label="Next match" ${hits.length ? "" : "disabled"}>${I.next}</button>
    <button class="icon-btn" data-find-close title="Close (Esc)" aria-label="Close find">${I.close}</button>${list}</div>`;
}
