import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { DakError } from "./types";
import { writeWakeScript } from "./wake";
import { installSkill, removeSkill } from "./skill";

// Connecting a tool means adding Dak's hook to its hooks file, so every session
// reads its Dak mail at the edges of each turn. Claude Code (~/.claude/settings.json)
// and Codex (~/.codex/hooks.json) share one format. We only ever add or remove our
// own entries, keep a copy of the file first, and leave the rest alone.

const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"] as const;
export type HookTool = "claude" | "codex" | "cursor";
const MARK: Record<HookTool, string> = { claude: " hook claude-code", codex: " hook codex", cursor: " hook cursor" };
// Cursor names its events differently and lists commands directly, not inside a "hooks" array.
const CURSOR_EVENTS = ["beforeSubmitPrompt", "stop"] as const;

export const hooksPath = (t: HookTool) => t === "claude"
  ? process.env.DAK_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json")
  : t === "codex" ? process.env.DAK_CODEX_HOOKS || join(homedir(), ".codex", "hooks.json")
  : process.env.DAK_CURSOR_HOOKS || join(homedir(), ".cursor", "hooks.json");

function read(t: HookTool): any {
  const path = hooksPath(t);
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new DakError("claude_settings_unreadable", `${path} is not valid JSON, so Dak will not touch it. Fix it and try again.`); }
}

// Claude Code also gets the wake hook (wake.sh), which wakes an idle session when mail arrives.
const isOurs = (t: HookTool, cmd: unknown) => typeof cmd === "string" && (cmd.endsWith(MARK[t]) || (t === "claude" && cmd.endsWith("/wake.sh")));
const ours = (t: HookTool) => (entry: any) => t === "cursor"
  ? isOurs(t, entry?.command)
  : (entry?.hooks ?? []).some((h: any) => isOurs(t, h?.command));
const hasWake = (s: any) => (s.hooks?.Stop ?? []).some((e: any) => (e?.hooks ?? []).some((h: any) => h?.asyncRewake && isOurs("claude", h.command)));
const eventsFor = (t: HookTool): readonly string[] => (t === "cursor" ? CURSOR_EVENTS : EVENTS);

// Codex's Stop hook may wait for mail for up to an hour ("keep listening"), so its limit is
// a little over that. Every other hook answers at once.
const CODEX_STOP_TIMEOUT = 3660;
const timeoutFor = (t: HookTool, e: string) => (t === "codex" && e === "Stop" ? CODEX_STOP_TIMEOUT : 5);

// Give an existing Codex connection the longer Stop limit. Codex sees a changed hook and asks
// the person to approve it again, once.
export function ensureCodexListenTimeout(): boolean {
  if (!connected("codex")) return false;
  const path = hooksPath("codex");
  const s = read("codex");
  let changed = false;
  for (const entry of s.hooks?.Stop ?? []) for (const h of entry?.hooks ?? []) {
    if (isOurs("codex", h?.command) && h.timeout !== CODEX_STOP_TIMEOUT) { h.timeout = CODEX_STOP_TIMEOUT; changed = true; }
  }
  if (changed) { copyFileSync(path, `${path}.before-dak`); writeFileSync(path, JSON.stringify(s, null, 2) + "\n"); }
  return changed;
}

export function connected(t: HookTool): boolean {
  const s = read(t);
  return eventsFor(t).every((e) => (s.hooks?.[e] ?? []).some(ours(t))) && (t !== "claude" || hasWake(s));
}

export function connect(t: HookTool, bin: string) {
  const path = hooksPath(t);
  const s = read(t);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, `${path}.before-dak`);
  s.hooks ??= {};
  if (t === "cursor") s.version ??= 1;
  for (const e of eventsFor(t)) {
    s.hooks[e] = (s.hooks[e] ?? []).filter((x: any) => !ours(t)(x));
    s.hooks[e].push(t === "cursor" ? { command: `${bin}${MARK[t]}`, timeout: 5 } : { hooks: [{ type: "command", command: `${bin}${MARK[t]}`, timeout: timeoutFor(t, e) }] });
  }
  // Codex and Cursor have no hook that can wake an idle session, so only Claude Code gets this.
  if (t === "claude") s.hooks.Stop.push({ hooks: [{ type: "command", command: writeWakeScript(), asyncRewake: true, timeout: 43200 }] });
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  installSkill(t); // and teach it how to use Dak
}

export function disconnect(t: HookTool) {
  const path = hooksPath(t);
  if (!existsSync(path)) return;
  const s = read(t);
  for (const e of eventsFor(t)) {
    if (!s.hooks?.[e]) continue;
    s.hooks[e] = s.hooks[e].filter((x: any) => !ours(t)(x));
    if (!s.hooks[e].length) delete s.hooks[e];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n");
  removeSkill(t);
}
