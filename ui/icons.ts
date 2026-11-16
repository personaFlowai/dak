// Interface icons are Phosphor (MIT), one family, one weight. Tool marks are
// Simple Icons (CC0) where the brand publishes one; OpenAI's mark comes from Phosphor.
// Every mark is drawn in currentColor, so agents never get colours of their own.
import tray from "@phosphor-icons/core/assets/regular/tray.svg" with { type: "text" };
import sent from "@phosphor-icons/core/assets/regular/paper-plane-tilt.svg" with { type: "text" };
import compose from "@phosphor-icons/core/assets/regular/note-pencil.svg" with { type: "text" };
import gear from "@phosphor-icons/core/assets/regular/gear-six.svg" with { type: "text" };
import sidebar from "@phosphor-icons/core/assets/regular/sidebar-simple.svg" with { type: "text" };
import sparkle from "@phosphor-icons/core/assets/regular/sparkle.svg" with { type: "text" };
import chat from "@phosphor-icons/core/assets/regular/chat-circle.svg" with { type: "text" };
import external from "@phosphor-icons/core/assets/regular/arrow-square-out.svg" with { type: "text" };
import check from "@phosphor-icons/core/assets/regular/check.svg" with { type: "text" };
import next from "@phosphor-icons/core/assets/regular/caret-right.svg" with { type: "text" };
import prev from "@phosphor-icons/core/assets/regular/caret-left.svg" with { type: "text" };
import pr from "@phosphor-icons/core/assets/regular/git-pull-request.svg" with { type: "text" };
import doc from "@phosphor-icons/core/assets/regular/file-text.svg" with { type: "text" };
import close from "@phosphor-icons/core/assets/regular/x.svg" with { type: "text" };
import search from "@phosphor-icons/core/assets/regular/magnifying-glass.svg" with { type: "text" };
import github from "@phosphor-icons/core/assets/regular/github-logo.svg" with { type: "text" };
import openai from "@phosphor-icons/core/assets/regular/open-ai-logo.svg" with { type: "text" };
import terminal from "@phosphor-icons/core/assets/regular/terminal-window.svg" with { type: "text" };
import up from "@phosphor-icons/core/assets/regular/arrow-up.svg" with { type: "text" };
import person from "@phosphor-icons/core/assets/regular/user-circle.svg" with { type: "text" };
import plug from "@phosphor-icons/core/assets/regular/plugs-connected.svg" with { type: "text" };
import warning from "@phosphor-icons/core/assets/regular/warning.svg" with { type: "text" };
import fileTs from "@phosphor-icons/core/assets/regular/file-ts.svg" with { type: "text" };
import fileTsx from "@phosphor-icons/core/assets/regular/file-tsx.svg" with { type: "text" };
import fileMd from "@phosphor-icons/core/assets/regular/file-md.svg" with { type: "text" };
import fileJs from "@phosphor-icons/core/assets/regular/file-js.svg" with { type: "text" };
import fileCss from "@phosphor-icons/core/assets/regular/file-css.svg" with { type: "text" };
import fileSql from "@phosphor-icons/core/assets/regular/file-sql.svg" with { type: "text" };
import fileCode from "@phosphor-icons/core/assets/regular/file-code.svg" with { type: "text" };
import expand from "@phosphor-icons/core/assets/regular/arrows-out-simple.svg" with { type: "text" };
import collapse from "@phosphor-icons/core/assets/regular/arrows-in-simple.svg" with { type: "text" };
import archive from "@phosphor-icons/core/assets/regular/archive.svg" with { type: "text" };
import columns from "@phosphor-icons/core/assets/regular/columns.svg" with { type: "text" };
import lineUp from "@phosphor-icons/core/assets/regular/arrow-line-up.svg" with { type: "text" };
import { siClaude, siCursor, siLinear, siNotion, siFigma } from "simple-icons";

const FILE_ICONS: Record<string, string> = { ts: fileTs, mts: fileTs, tsx: fileTsx, jsx: fileTsx, md: fileMd, js: fileJs, mjs: fileJs, css: fileCss, sql: fileSql };
export const fileIcon = (path: string) => FILE_ICONS[path.split(".").pop()?.toLowerCase() ?? ""] ?? fileCode;

export const I = { archive, columns, expand, collapse, lineUp, tray, sent, compose, gear, sidebar, sparkle, chat, external, check, next, prev, pr, doc, close, search, github, terminal, up, person, plug, warning };

const brand = (path: string) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${path}"/></svg>`;

// Where a link goes, named the way a person would say it: "ENG-123 in Linear", not the URL.
export function linkInfo(url: string, name: string): { mark: string; title: string; where: string } {
  let u: URL; try { u = new URL(url); } catch { return { mark: external, title: name, where: url }; }
  const host = u.hostname.replace(/^www\./, "");
  const words = (s: string) => { const w = decodeURIComponent(s).replace(/-[0-9a-f]{32}$/i, "").replace(/[-_]+/g, " ").trim(); return w.charAt(0).toUpperCase() + w.slice(1); };
  const named = name && name !== url ? name : "";
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "linear.app") {
    const i = parts.indexOf("issue"), p = parts.indexOf("project");
    const title = i >= 0 ? `${parts[i + 1]}${parts[i + 2] ? ` · ${words(parts[i + 2])}` : ""}` : p >= 0 ? words(parts[p + 1] ?? "") : "Linear";
    return { mark: brand(siLinear.path), title: named || title, where: "Linear" };
  }
  if (host.endsWith("notion.so") || host.endsWith("notion.site")) {
    const last = parts[parts.length - 1] ?? "";
    return { mark: brand(siNotion.path), title: named || words(last) || "Notion page", where: "Notion" };
  }
  if (host === "github.com") {
    const pr = parts[2] === "pull" ? `PR #${parts[3]}` : parts[2] === "issues" ? `Issue #${parts[3]}` : "";
    return { mark: github, title: named || [pr, parts.slice(0, 2).join("/")].filter(Boolean).join(" · "), where: "GitHub" };
  }
  if (host.endsWith("figma.com")) return { mark: brand(siFigma.path), title: named || words(parts[2] ?? "") || "Figma file", where: "Figma" };
  if (host === "claude.ai" && parts.includes("artifact")) return { mark: external, title: named || "Artifact", where: "Claude artifact" };
  return { mark: external, title: named || host, where: host };
}

export const TOOLS: Record<string, { label: string; mark: string }> = {
  "claude-code": { label: "Claude Code", mark: brand(siClaude.path) },
  cursor: { label: "Cursor", mark: brand(siCursor.path) },
  codex: { label: "Codex", mark: openai },
  github: { label: "GitHub", mark: github },
  grok: { label: "Grok", mark: "" },
  cli: { label: "Shell", mark: terminal },
  http: { label: "HTTP", mark: terminal },
};
