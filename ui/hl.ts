import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import yaml from "highlight.js/lib/languages/yaml";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import markdown from "highlight.js/lib/languages/markdown";
import ini from "highlight.js/lib/languages/ini";

for (const [n, l] of Object.entries({ typescript, javascript, json, css, xml, bash, python, sql, swift, yaml, go, rust, markdown, ini })) {
  hljs.registerLanguage(n, l as any);
}

const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", html: "xml", xml: "xml", svg: "xml", sh: "bash", zsh: "bash", py: "python", sql: "sql",
  swift: "swift", yml: "yaml", yaml: "yaml", go: "go", rs: "rust", md: "markdown", toml: "ini",
};

export const langFor = (path: string) => BY_EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Highlight a whole file, then cut it into lines. highlight.js spans can cross
// newlines (a block comment), so each line closes the spans still open and the
// next line reopens them; per-line highlighting would get those wrong.
export function highlightLines(code: string, path: string): string[] {
  const lang = langFor(path);
  let html: string;
  try { html = lang ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : esc(code); }
  catch { html = esc(code); }
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) { open.push(m[1]); line += m[1]; }
    else if (m[2]) { open.pop(); line += m[2]; }
    else if (m[3]) { out.push(line + "</span>".repeat(open.length)); line = open.join(""); }
    else line += m[4];
  }
  out.push(line + "</span>".repeat(open.length));
  return out;
}

export function highlightLine(text: string, path: string): string {
  return highlightLines(text, path)[0] ?? "";
}
