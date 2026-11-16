import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

// Links open outside the app; a review screen should never navigate away.
const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener");
  return defaultLink(tokens, idx, opts, env, self);
};

export interface Block { index: number; html: string; text: string; hash: string; from: number; to: number } // from/to: 1-based source lines

// FNV-1a: stable, tiny, and plenty to tell blocks apart within one document.
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Each top-level block (a paragraph, heading, list, table or code block) is one
// place a comment can hang. Its hash is of its source, so a comment finds its
// block again in the next version when the block did not change.
export function blocks(source: string): Block[] {
  const tokens = md.parse(source, {});
  const lines = source.split("\n");
  const out: Block[] = [];
  let start = -1;
  let depth = 0;
  tokens.forEach((t, i) => {
    if (depth === 0) start = i;
    depth += t.nesting;
    if (depth === 0) {
      const slice = tokens.slice(start, i + 1);
      const map = slice.find((x) => x.map)?.map;
      const src = map ? lines.slice(map[0], map[1]).join("\n") : slice.map((x) => x.content).join("\n");
      const text = slice.map((x) => (x.type === "inline" || x.type === "fence" || x.type === "code_block") ? x.content : "").join(" ")
        // Plain words for the quote a comment carries: no Markdown markers.
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]+/g, "").replace(/\s+/g, " ").trim();
      out.push({ index: out.length, html: md.renderer.render(slice, md.options, {}), text, hash: hash(src.trim()), from: map ? map[0] + 1 : 0, to: map ? map[1] : 0 });
    }
  });
  return out;
}

export const render = (s: string) => md.render(s);
