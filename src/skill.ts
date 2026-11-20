import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import skillText from "../skills/dak/SKILL.md" with { type: "text" };
import workText from "../skills/dak-work/SKILL.md" with { type: "text" };
import guideText from "../skills/dak/GUIDE.md" with { type: "text" };

// Teaching an agent to use Dak, as part of connecting it. The skill ships inside the
// binary, so this works without the source. Each tool gets it where it reads instructions:
//   Claude Code: two skills, ~/.claude/skills/dak/SKILL.md (sending and reading) and
//   ~/.claude/skills/dak-work/SKILL.md (what work is and how to move it), each loaded when relevant.
//   Codex: a marked section in ~/.codex/AGENTS.md, its global instructions.
//   Cursor: keeps global rules in its settings screen, so Settings offers the text to copy.
// Dak only ever removes what it wrote: a copy it marked, or the section between its markers.

const MARK = "<!-- Installed by Dak. Disconnecting Claude Code in Dak removes this copy. -->";
const START = "<!-- dak:start (added by Dak; Disconnect Codex in Dak removes this section) -->";
const END = "<!-- dak:end -->";

export const SKILL = skillText as unknown as string;
export const WORK_SKILL = workText as unknown as string;
// The long reference the skill points to; `dak help guide` prints it, so it costs nothing until asked for.
export const GUIDE = guideText as unknown as string;

// Codex runs a hook only after the person approves it, so its mail must not depend on one.
const CODEX_FIRST = `**Every task, in Codex:** run \`dak inbox --unread --json\` when you start and again before you finish, and act on anything there first. Your name on Dak is what \`dak whoami\` prints; \`dak send\`, \`reply\`, \`inbox\` and \`wait\` fill it in, so you never need \`--from\` or \`--for\`.`;
// The skill without its front matter: plain instructions for tools that have no skills.
const plain = (t: string) => t.replace(/^---[\s\S]*?---\s*/, "").trim();
export const INSTRUCTIONS = `${plain(SKILL)}\n\n${plain(WORK_SKILL).replace(/^# /, "## ")}`;

const claudeSkill = (name = "dak") => join(process.env.DAK_CLAUDE_SKILLS || join(homedir(), ".claude", "skills"), name, "SKILL.md");
const CLAUDE_SKILLS: [string, () => string][] = [["dak", () => SKILL], ["dak-work", () => WORK_SKILL]];
const codexAgents = () => process.env.DAK_CODEX_AGENTS || join(homedir(), ".codex", "AGENTS.md");

export function installSkill(tool: "claude" | "codex" | "cursor") {
  if (tool === "claude") for (const [name, text] of CLAUDE_SKILLS) {
    const path = claudeSkill(name), dir = dirname(path);
    // A skill folder you linked yourself (to a checkout of Dak) is yours: leave it.
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) continue;
    if (existsSync(path) && !readFileSync(path, "utf8").includes(MARK)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text().replace(/^(---[\s\S]*?---\s*)/, `$1${MARK}\n\n`));
  }
  if (tool === "codex") {
    const path = codexAgents();
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const rest = stripSection(before).trimEnd();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${rest ? rest + "\n\n" : ""}${START}\n## Dak\n\n${CODEX_FIRST}\n\n${INSTRUCTIONS}\n${END}\n`);
  }
}

export function removeSkill(tool: "claude" | "codex" | "cursor") {
  if (tool === "claude") for (const [name] of CLAUDE_SKILLS) {
    const path = claudeSkill(name), dir = dirname(path);
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) continue;
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
