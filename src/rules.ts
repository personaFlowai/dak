/* Rules: what the person has said goes, in one list only they write.

   Four are kept by Dak itself, in code, so they hold whichever agent or tool is on the other end.
   The rest are the person's own words (a freeze, a standing OK) for every agent to read, and a
   permissions list: what each agent may do without asking. Agents read this list; no agent
   command writes it, and the server takes a change only from the person. */
import { loadConfig, person } from "./config";
import { store } from "./store";
import { DakError } from "./types";

export const KEPT_BY_DAK = [
  { key: "approve", text: "Only you approve.", how: "An approval counts only as your verdict on the topic. An agent's \"approved\" is a message, nothing more." },
  { key: "proof", text: "Done needs proof.", how: "A piece of work cannot be marked done without saying what proves it." },
  { key: "gate", text: "Nothing reaches you half-ready.", how: "\"Ready for you\" needs proof and the topic that briefs it. Without them Dak sends it back to its owner with what is missing." },
  { key: "start", text: "No work, no start.", how: "Dak starts an agent on its own only when it has a piece of work, or a ticket in its pile, to start from." },
];

export interface Rule { id: number; text: string; by: string; at: string }
export interface Permission { id: number; agent: string; may: string; by: string; at: string }

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS permissions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, may TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL);`);
}

function onlyPerson(by: string) {
  const me = person(loadConfig());
  if (by !== me) throw new DakError("not_yours", `Only ${me} writes the rules.`, 403);
}

export function rules() {
  ensure();
  return {
    kept: KEPT_BY_DAK,
    rules: store().query("SELECT * FROM rules ORDER BY id").all() as Rule[],
    permissions: store().query("SELECT * FROM permissions ORDER BY agent, id").all() as Permission[],
  };
}

export function addRule(text: string, by: string) {
  onlyPerson(by);
  if (!text?.trim()) throw new DakError("no_text", "Say the rule.");
  ensure();
  store().query("INSERT INTO rules (text, by, at) VALUES (?,?,?)").run(text.trim(), by, new Date().toISOString());
  return rules();
}
export function addPermission(agent: string, may: string, by: string) {
  onlyPerson(by);
  if (!agent?.trim() || !may?.trim()) throw new DakError("no_text", "Name the agent and what it may do.");
  ensure();
  store().query("INSERT INTO permissions (agent, may, by, at) VALUES (?,?,?,?)").run(agent.trim().toLowerCase(), may.trim(), by, new Date().toISOString());
  return rules();
}
export function removeRule(kind: "rule" | "permission", id: number, by: string) {
  onlyPerson(by);
  ensure();
  store().query(`DELETE FROM ${kind === "rule" ? "rules" : "permissions"} WHERE id = ?`).run(id);
  return rules();
}
