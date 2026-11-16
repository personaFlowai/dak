import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir, userInfo } from "node:os";
import { randomBytes } from "node:crypto";
import type { Reader } from "./types";

// DAK_HOME lets tests and second installs keep their own store.
export function dakHome(): string {
  const home = process.env.DAK_HOME || join(homedir(), ".dak");
  mkdirSync(join(home, "blobs"), { recursive: true });
  return home;
}

export interface ReaderConfig extends Reader {
  about?: string; // one line: what this agent does ("Coordinates the engineers")
  tool?: string; // claude-code, codex, cursor, grok
  where?: string; // the session folder this name belongs to, so the hook can tell it is Atlas
}

export type HelperName = "claude" | "codex" | "cursor" | "custom";

export interface Config {
  readers: ReaderConfig[];
  port: number;
  helper: HelperName;
  explain: { command: string[]; timeout_seconds: number };
  models: Partial<Record<HelperName, string>>; // empty means the tool's own default
}

// The read-only helper behind Explain and Ask. Each preset is told to read only;
// Claude Code also enforces it with its tool list, and Codex with its sandbox.
// How each tool is told which model to use. Claude Code takes aliases (opus, sonnet, haiku).
export const MODEL_FLAG: Record<Exclude<HelperName, "custom">, string> = { claude: "--model", codex: "-m", cursor: "--model" };

export const HELPERS: Record<Exclude<HelperName, "custom">, { label: string; command: string[] }> = {
  claude: { label: "Claude Code", command: ["claude", "-p", "--allowedTools", "Read,Grep,Glob", "--output-format", "text"] },
  codex: { label: "Codex", command: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"] },
  cursor: { label: "Cursor", command: ["cursor-agent", "-p", "--output-format", "text"] },
};

export function configPath() {
  return join(dakHome(), "config.toml");
}

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) {
    writeConfig({ readers: [{ name: userInfo().username.toLowerCase(), kind: "person" }], port: 7474, helper: "claude", explain: { command: HELPERS.claude.command, timeout_seconds: 180 }, models: {} });
  }
  const raw = Bun.TOML.parse(readFileSync(path, "utf8")) as any;
  const readers: ReaderConfig[] = (raw.readers ?? []).map((r: any) => ({
    name: String(r.name).toLowerCase(),
    kind: r.kind === "person" ? "person" : "agent",
    ...(r.about ? { about: String(r.about) } : {}),
    ...(r.tool ? { tool: String(r.tool) } : {}),
    ...(r.where ? { where: String(r.where) } : {}),
  }));
  const helper: HelperName = ["claude", "codex", "cursor", "custom"].includes(raw.explain?.helper) ? raw.explain.helper : "claude";
  const command = helper === "custom" ? (raw.explain?.command ?? HELPERS.claude.command) : (raw.explain?.command ?? HELPERS[helper].command);
  return {
    readers,
    port: Number(process.env.DAK_PORT || raw.port || 7474),
    helper,
    explain: { command, timeout_seconds: raw.explain?.timeout_seconds ?? 180 },
    models: Object.fromEntries(Object.entries(raw.explain?.models ?? {}).map(([k, v]) => [k, String(v)]).filter(([, v]) => v)),
  };
}

const q = (s: string) => JSON.stringify(s);

export function writeConfig(c: Config) {
  const lines = [
    "# Dak configuration. Edit here or in the app's Settings.",
    `port = ${c.port}`,
    "",
    ...c.readers.flatMap((r) => [
      "[[readers]]", `name = ${q(r.name)}`, `kind = ${q(r.kind)}`,
      ...(r.about ? [`about = ${q(r.about)}`] : []), ...(r.tool ? [`tool = ${q(r.tool)}`] : []), ...(r.where ? [`where = ${q(r.where)}`] : []), "",
    ]),
    "[explain]",
    "# helper: claude, codex, cursor, or custom (then command is used as written).",
    `helper = ${q(c.helper)}`,
    `command = ${JSON.stringify(c.explain.command)}`,
    `timeout_seconds = ${c.explain.timeout_seconds}`,
    "",
    "[explain.models]",
    "# Model per helper; leave out for the tool's own default.",
    ...Object.entries(c.models ?? {}).filter(([, v]) => v).map(([k, v]) => `${k} = ${q(v!)}`),
    "",
  ];
  writeFileSync(configPath(), lines.join("\n"));
}

export function setModel(helper: HelperName, model: string) {
  const c = loadConfig();
  const m = model.trim();
  if (m && !/^[A-Za-z0-9._:\-\/]+$/.test(m)) throw new Error("bad model");
  c.models = { ...c.models, [helper]: m };
  if (!m) delete c.models[helper];
  writeConfig(c);
}

export function setHelper(helper: HelperName, command?: string[]) {
  const c = loadConfig();
  c.helper = helper;
  c.explain.command = helper === "custom" ? (command?.length ? command : c.explain.command) : HELPERS[helper].command;
  writeConfig(c);
}

// The reader a working folder belongs to, if one is bound to it.
export function readerForFolder(folder: string): string | null {
  const c = loadConfig();
  const hit = c.readers.find((r) => r.where && (r.where === folder || r.where === basename(folder)));
  return hit?.name ?? null;
}

// The token stops other local web pages from using the API: a page can make the
// browser send a request, but it cannot read this owner-only file.
export function token(): string {
  const path = join(dakHome(), "token");
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes(24).toString("hex"));
    chmodSync(path, 0o600);
  }
  return readFileSync(path, "utf8").trim();
}

export function person(config: Config): string {
  return config.readers.find((r) => r.kind === "person")?.name ?? "me";
}
