/* The team: everyone who works through Dak, wherever they run, in one list. Agents on this Mac
   (from presence), agents outside it that hold a door key, the bots those agents speak as, and
   the person. The person can give each one a name to show, a role, an area, and what it can and
   cannot do, so work and @mentions go to the right one. Only the person edits this; agents read it. */
import { agents, seatsOf, superseded, type Seat } from "./presence";
import { sessionRunning } from "./sleeper";
import { loadConfig } from "./config";
import { store } from "./store";
import { keyNames } from "./tunnel";
import { DakError } from "./types";

export type MemberKind = "person" | "local" | "cloud" | "bot";
export interface TeamMember {
  name: string; // the address: what @mentions and --to use
  display: string | null; // what the person calls it ("Lead")
  role: string | null; // "CTO", "Head of product"
  area: string | null; // what it owns: "Billing", "the settings page"
  can: string | null; // "writes code in my-app"
  cannot: string | null; // "no repo access", "drafts only"
  kind: MemberKind;
  tool: string | null; // claude-code, codex, cursor, grok, http
  via: string | null; // for a bot: the door key it speaks through
  last_seen: string | null;
  listening: boolean;
  reader: boolean; // a named reader in Dak's settings ("lead"), not a session found by its folder
  carded: boolean; // the person has written this member's card
  lead: boolean; // the one member the person marked Lead: the Board's notes on assignments go to them
  seats: (Seat & { state: "working" | "open" | "closed" })[]; // its sessions this week: working now, open and idle, or closed
}
export type MemberFields = Partial<Pick<TeamMember, "display" | "role" | "area" | "can" | "cannot" | "lead">>;

function ensure() {
  store().exec(`CREATE TABLE IF NOT EXISTS team (name TEXT PRIMARY KEY, display TEXT, role TEXT, area TEXT, can TEXT, cannot TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS door_bots (name TEXT PRIMARY KEY, agent TEXT NOT NULL, at TEXT NOT NULL)`);
  const cols = new Set((store().query("PRAGMA table_info(team)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("lead")) store().exec("ALTER TABLE team ADD COLUMN lead INTEGER");
}

// The member the person marked Lead, if any. Dak has no idea of a lead by name: the person says who.
export function leadName(): string | null {
  ensure();
  return (store().query("SELECT name FROM team WHERE lead = 1 LIMIT 1").get() as { name: string } | null)?.name ?? null;
}

export function team(opts: { all?: boolean } = {}): TeamMember[] {
  ensure();
  const cfg = loadConfig();
  const byName = new Map<string, TeamMember>();
  const blank = (name: string, kind: MemberKind): TeamMember =>
    ({ name, display: null, role: null, area: null, can: null, cannot: null, kind, tool: null, via: null, last_seen: null, listening: false, reader: false, carded: false, lead: false, seats: [] });
  for (const a of agents({ all: opts.all })) {
    const m = blank(a.name, a.kind === "person" ? "person" : a.tool === "grok" || a.tool === "http" ? "cloud" : "local");
    Object.assign(m, { tool: a.tool, last_seen: a.last_seen, listening: a.listening, display: a.title ?? null, role: a.about ?? null, reader: a.reader });
    byName.set(a.name, m);
  }
  for (const k of keyNames()) if (!byName.has(k)) byName.set(k, { ...blank(k, "cloud"), tool: "http" });
  for (const b of store().query("SELECT name, agent FROM door_bots").all() as { name: string; agent: string }[]) {
    const m = byName.get(b.name) ?? blank(b.name, "bot");
    byName.set(b.name, { ...m, kind: "bot", via: b.agent });
  }
  // What the person wrote wins over what was guessed.
  for (const r of store().query("SELECT * FROM team").all() as any[]) {
    const m = byName.get(r.name);
    if (!m) continue; // a member that left: kept in the table, not listed
    m.carded = true;
    m.lead = r.lead === 1;
    for (const f of ["display", "role", "area", "can", "cannot"] as const) if (r[f] !== null) m[f] = r[f];
  }
  // The plain list keeps it to the team you would recognise: readers, anyone with a card, agents
  // outside this Mac, and sessions active in the last three days. --all shows every name ever seen.
  if (!opts.all) {
    const carded = new Set((store().query("SELECT name FROM team").all() as { name: string }[]).map((r) => r.name));
    const readers = new Set(cfg.readers.map((r) => r.name));
    const recent = Date.now() - 3 * 86_400_000;
    for (const [n, m] of byName) {
      if (readers.has(n) || carded.has(n) || m.kind === "cloud" || m.kind === "bot" || (m.last_seen && Date.parse(m.last_seen) > recent)) continue;
      byName.delete(n);
    }
  }
  // A folder name a session dropped for a member's name is that member's seat, not a member.
  const carded = new Set((store().query("SELECT name FROM team").all() as { name: string }[]).map((r) => r.name));
  for (const n of superseded()) if (!carded.has(n) && !cfg.readers.some((r) => r.name === n)) byName.delete(n);
  const now = Date.now();
  for (const m of byName.values()) m.seats = seatsOf(m.name).map((x) => ({ ...x,
    state: now - Date.parse(x.last_seen) < 3 * 60_000 ? "working" : x.tool === "claude-code" && sessionRunning(x.session_id) ? "open" : "closed" }));
  const me = cfg.readers.find((r) => r.kind === "person")?.name;
  const rank = (m: TeamMember) => (m.name === me ? 0 : m.kind === "person" ? 1 : m.display || m.role ? 2 : 3);
  return [...byName.values()].sort((a, b) => rank(a) - rank(b) || (b.last_seen ?? "").localeCompare(a.last_seen ?? "") || a.name.localeCompare(b.name));
}

export function setMember(name: string, fields: MemberFields): TeamMember {
  ensure();
  const n = name.trim().toLowerCase();
  if (!team({ all: true }).some((m) => m.name === n)) throw new DakError("no_member", `No one called ${n} works through Dak yet.`, 404);
  const clean = (v: unknown) => (v === undefined ? undefined : String(v ?? "").trim().slice(0, 200) || null);
  const cur = (store().query("SELECT * FROM team WHERE name = ?").get(n) as any) ?? {};
  const next = { display: cur.display ?? null, role: cur.role ?? null, area: cur.area ?? null, can: cur.can ?? null, cannot: cur.cannot ?? null };
  for (const f of ["display", "role", "area", "can", "cannot"] as const) { const v = clean(fields[f]); if (v !== undefined) next[f] = v; }
  // One lead at most: marking one clears whoever was lead before.
  const lead = fields.lead === undefined ? cur.lead ?? null : fields.lead ? 1 : null;
  if (lead) store().query("UPDATE team SET lead = NULL WHERE name != ?").run(n);
  store().query("INSERT OR REPLACE INTO team (name, display, role, area, can, cannot, lead, updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(n, next.display, next.role, next.area, next.can, next.cannot, lead, new Date().toISOString());
  return team({ all: true }).find((m) => m.name === n)!;
}

// Everyone who could be @mentioned, cheaply (no session scan): readers, anyone seen, door keys, bots.
export function memberNames(): string[] {
  ensure();
  const names = new Set<string>(loadConfig().readers.map((r) => r.name));
  for (const r of store().query("SELECT name FROM presence").all() as { name: string }[]) names.add(r.name);
  for (const k of keyNames()) names.add(k);
  for (const r of store().query("SELECT name FROM door_bots").all() as { name: string }[]) names.add(r.name);
  return [...names];
}

// The @names in a message that are on the team: "@lead, can you" → ["lead"]. Case does not
// matter; an @word that is nobody (an email, a decorator, "@types/node") is left alone.
export function mentionsIn(text: string, members: string[]): string[] {
  const known = new Set(members);
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w@./])@([a-z0-9][a-z0-9_-]{0,59})(?![\w/.@-]*[\w/@])/gi)) {
    const n = m[1].toLowerCase();
    if (known.has(n)) found.add(n);
  }
  return [...found];
}
