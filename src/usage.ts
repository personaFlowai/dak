/* What each agent wrote into Dak and was handed by it, per day, in characters: the measure of
   what Dak costs in tokens. Written: the bodies of its messages (counted from the store). Read:
   every brief its hooks handed it (counted as they are handed). */
import { store } from "./store";

function ensure() {
  store().exec("CREATE TABLE IF NOT EXISTS usage_read (agent TEXT NOT NULL, day TEXT NOT NULL, chars INTEGER NOT NULL, briefs INTEGER NOT NULL, PRIMARY KEY (agent, day))");
}
const today = () => new Date().toISOString().slice(0, 10);

export function countRead(agent: string, chars: number) {
  if (!chars) return;
  try {
    ensure();
    store().query("INSERT INTO usage_read VALUES (?,?,?,1) ON CONFLICT(agent, day) DO UPDATE SET chars = chars + excluded.chars, briefs = briefs + 1").run(agent, today(), chars);
  } catch { /* a read-only run (a reviewer's sandbox) counts nothing */ }
}

export interface Usage { agent: string; day: string; wrote: number; messages: number; read: number; briefs: number }
// Per agent per day for the last `days` days, newest first.
export function usage(days = 7, agent?: string): Usage[] {
  ensure();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const wrote = store().query(`SELECT author AS agent, substr(created_at, 1, 10) AS day, sum(length(body)) AS wrote, count(*) AS messages
    FROM messages WHERE substr(created_at, 1, 10) >= ? GROUP BY 1, 2`).all(since) as any[];
  const read = store().query("SELECT agent, day, chars AS read, briefs FROM usage_read WHERE day >= ?").all(since) as any[];
  const by = new Map<string, Usage>();
  for (const r of wrote) by.set(`${r.agent}|${r.day}`, { agent: r.agent, day: r.day, wrote: r.wrote ?? 0, messages: r.messages, read: 0, briefs: 0 });
  for (const r of read) { const k = `${r.agent}|${r.day}`; const u = by.get(k) ?? { agent: r.agent, day: r.day, wrote: 0, messages: 0, read: 0, briefs: 0 }; u.read = r.read; u.briefs = r.briefs; by.set(k, u); }
  return [...by.values()].filter((u) => !agent || u.agent === agent).sort((a, b) => b.day.localeCompare(a.day) || (b.wrote + b.read) - (a.wrote + a.read));
}
