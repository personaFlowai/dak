// A small unified-diff parser: enough for git and gh output, which is all Dak is sent.

export interface Hunk {
  old_start: number; old_lines: number; new_start: number; new_lines: number;
  header: string;
  lines: string[]; // each starts with " ", "+", "-" or "\"
}

export interface DiffFile {
  path: string;
  old_path: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | null = null;
  let h: Hunk | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      f = { path: m?.[2] ?? "", old_path: m?.[1] ?? null, status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith("new file mode")) f.status = "added";
      else if (line.startsWith("deleted file mode")) f.status = "deleted";
      else if (line.startsWith("rename to ")) { f.status = "renamed"; f.path = line.slice(10); }
      else if (line.startsWith("rename from ")) f.old_path = line.slice(12);
      else if (line.startsWith("Binary files")) f.binary = true;
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") f.path = line.slice(4).replace(/^b\//, "");
    }
    const m = line.match(HUNK);
    if (m) {
      h = { old_start: +m[1], old_lines: m[2] === undefined ? 1 : +m[2], new_start: +m[3],
        new_lines: m[4] === undefined ? 1 : +m[4], header: m[5] ?? "", lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (h && (line[0] === " " || line[0] === "+" || line[0] === "-" || line[0] === "\\")) {
      h.lines.push(line);
      if (line[0] === "+") f.additions++;
      if (line[0] === "-") f.deletions++;
    } else if (h && line === "") {
      // A blank context line can lose its leading space in some tools.
      h.lines.push(" ");
    }
  }
  for (const file of files) {
    if (file.status !== "renamed" && file.old_path === file.path) file.old_path = null;
    for (const hunk of file.hunks) trimHunk(hunk);
  }
  return files;
}

// Drop the trailing blank lines that splitting adds beyond the hunk's own counts.
function trimHunk(h: Hunk) {
  let olds = 0, news = 0, keep = 0;
  for (const l of h.lines) {
    if (olds >= h.old_lines && news >= h.new_lines && l[0] !== "\\") break;
    keep++;
    if (l[0] === " " ) { olds++; news++; } else if (l[0] === "-") olds++; else if (l[0] === "+") news++;
  }
  h.lines = h.lines.slice(0, keep);
}

// The hunk's start as chapters refer to it: the new side, or the old side for a deletion.
export function hunkStart(file: DiffFile, h: Hunk): number {
  return file.status === "deleted" ? h.old_start : h.new_start;
}

export function lineInDiff(files: DiffFile[], path: string, side: "old" | "new", line: number): boolean {
  const f = files.find((x) => x.path === path);
  if (!f) return false;
  return f.hunks.some((h) => side === "new"
    ? line >= h.new_start && line < h.new_start + Math.max(h.new_lines, 1)
    : line >= h.old_start && line < h.old_start + Math.max(h.old_lines, 1));
}
