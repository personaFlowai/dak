/* "Ready for review" handoffs and priced asks: the fixed fields checked before a review starts,
   refused at send time when one is missing, because a missing proof or a stale head is where
   mistakes slip through. */
import { DakError, ROLES, type Cost, type Handoff, type Participant, type PrMeta, type Proof, type Role } from "./types";

// --proof tests:pass:412, --proof build:pass, --proof pgtap:fail:2
export function parseProof(s: string): Proof {
  const m = s.trim().match(/^([^:]+):(pass|fail)(?::(\d+))?$/i);
  if (!m) throw new DakError("bad_proof", `"${s}" is not a proof. Write name:pass or name:fail, with an optional count: tests:pass:412.`);
  return { name: m[1].trim(), result: m[2].toLowerCase() as "pass" | "fail", ...(m[3] ? { count: Number(m[3]) } : {}) };
}

// --skipped "e2e: no device today"
export function parseSkipped(s: string): { name: string; reason: string } {
  const i = s.indexOf(":");
  const name = i > 0 ? s.slice(0, i).trim() : "", reason = i > 0 ? s.slice(i + 1).trim() : "";
  if (!name || !reason) throw new DakError("bad_skipped", `"${s}": say what was skipped and why, as "name: reason".`);
  return { name, reason };
}

export function buildHandoff(meta: PrMeta | null, v: { head?: string; migration?: string; proof?: string[]; skipped?: string[] }): Handoff {
  if (!meta) throw new DakError("no_pr", "A ready-for-review handoff goes with the PR: add --pr <n> or --base <ref>.");
  const missing: string[] = [];
  if (!v.migration?.trim()) missing.push(`--migration <file name, or "none">`);
  if (!v.proof?.length) missing.push("--proof name:pass|fail[:count], at least one (tests, build, pgtap...)");
  if (missing.length) throw new DakError("handoff_incomplete", "A ready-for-review handoff needs:\n  " + missing.join("\n  "));
  const head = meta.head_sha ?? "";
  // The head the proofs ran on must be the head being reviewed.
  const claimed = v.head?.trim();
  if (claimed && head && !head.startsWith(claimed) && !claimed.startsWith(head)) {
    throw new DakError("stale_head", `Your proofs ran on ${claimed.slice(0, 12)}, but the PR's head is ${head.slice(0, 12)}. Re-run them on the head, or push.`);
  }
  return { head, base: meta.base_ref ?? meta.base_sha, migration: v.migration!.trim(), proofs: v.proof!.map(parseProof), skipped: (v.skipped ?? []).map(parseSkipped) };
}

export function buildCost(v: { cost?: string; cap?: string }): Cost | undefined {
  if (v.cost === undefined && v.cap === undefined) return undefined;
  const estimate = Number(v.cost), cap = v.cap === undefined ? undefined : Number(v.cap);
  if (!Number.isFinite(estimate) || estimate < 0) throw new DakError("bad_cost", "--cost is the estimate in dollars, e.g. --cost 0.15.");
  if (cap !== undefined && (!Number.isFinite(cap) || cap < estimate)) throw new DakError("bad_cost", "--cap is the most it may spend, at least the estimate.");
  return { estimate, ...(cap !== undefined ? { cap } : {}), currency: "USD" };
}

// --cc codex:reviewer --cc lead:watcher (a bare name is a watcher)
export function parseParticipant(s: string): Participant {
  const [name, role = "watcher"] = s.split(":").map((x) => x.trim().toLowerCase());
  if (!name) throw new DakError("bad_participant", "Write --cc name:role, e.g. --cc codex:reviewer.");
  if (!ROLES.includes(role as Role)) throw new DakError("bad_role", `Role must be one of: ${ROLES.join(", ")}.`);
  return { name, role: role as Role };
}

export const money = (n: number) => `$${n.toFixed(2)}`;

export function describeHandoff(h: Handoff): string {
  const proofs = h.proofs.map((p) => `${p.name} ${p.result}${p.count !== undefined ? ` (${p.count})` : ""}`).join(", ");
  const skipped = h.skipped.map((s) => `${s.name}: ${s.reason}`).join("; ");
  return `Ready for review at ${h.head.slice(0, 12)}${h.base ? ` on ${h.base.slice(0, 12)}` : ""} · migration ${h.migration} · ${proofs}${skipped ? ` · skipped ${skipped}` : ""}`;
}

export function describeCost(c: Cost): string {
  return `Costs about ${money(c.estimate)}${c.cap !== undefined ? `, capped at ${money(c.cap)}` : ""}`;
}
