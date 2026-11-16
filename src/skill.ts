import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import skillText from "../skills/dak/SKILL.md" with { type: "text" };

// Teaching an agent to use Dak, as part of connecting it. The skill ships inside the
// binary, so this works without the source. Each tool gets it where it reads instructions:
//   Claude Code: a skill at ~/.claude/skills/dak/SKILL.md, loaded when it is relevant.
//   Codex: a marked section in ~/.codex/AGENTS.md, its global instructions.
//   Cursor: keeps global rules in its settings screen, so Settings offers the text to copy.
// Dak only ever removes what it wrote: a copy it marked, or the section between its markers.

const MARK = "<!-- Installed by Dak. Disconnecting Claude Code in Dak removes this copy. -->";
const START = "<!-- dak:start (added by Dak; Disconnect Codex in Dak removes this section) -->";
const END = "<!-- dak:end -->";

export const SKILL = skillText as unknown as string;
// The skill without its front matter: plain instructions for tools that have no skills.
export const INSTRUCTIONS = SKILL.replace(/^---[\s\S]*?---\s*/, "").trim();

const claudeSkill = () => join(process.env.DAK_CLAUDE_SKILLS || join(homedir(), ".claude", "skills"), "dak", "SKILL.md");
const codexAgents = () => process.env.DAK_CODEX_AGENTS || join(homedir(), ".codex", "AGENTS.md");

export function installSkill(tool: "claude" | "codex" | "cursor") {
  if (tool === "claude") {
    const path = claudeSkill(), dir = dirname(path);
    // A skill folder you linked yourself (to a checkout of Dak) is yours: leave it.
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) return;
    if (existsSync(path) && !readFileSync(path, "utf8").includes(MARK)) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, SKILL.replace(/^(---[\s\S]*?---\s*)/, `$1${MARK}\n\n`));
  }
  if (tool === "codex") {
    const path = codexAgents();
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const rest = stripSection(before).trimEnd();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${rest ? rest + "\n\n" : ""}${START}\n## Dak\n\n${INSTRUCTIONS}\n${END}\n`);
  }
}

export function removeSkill(tool: "claude" | "codex" | "cursor") {
  if (tool === "claude") {
    const path = claudeSkill(), dir = dirname(path);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) return;
    if (existsSync(path) && readFileSync(path, "utf8").includes(MARK)) rmSync(dir, { recursive: true, force: true });
  }
  if (tool === "codex") {
    const path = codexAgents();
    if (!existsSync(path)) return;
    const before = readFileSync(path, "utf8");
    const after = stripSection(before).trimEnd();
    if (after !== before.trimEnd()) writeFileSync(path, after ? after + "\n" : "");
  }
}

function stripSection(text: string): string {
  const a = text.indexOf(START), b = text.indexOf(END);
  return a >= 0 && b > a ? text.slice(0, a) + text.slice(b + END.length) : text;
}
