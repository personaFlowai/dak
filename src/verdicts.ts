/* Who approved what, on a thread that can carry several PRs. One rule, used by the server, the
   merge queue and the page, so they can never disagree about whether #2450 is approved.

   A PR is known by its number: a new attachment with the same number is that PR's next version,
   a different number is a different PR on the same topic. Changes sent without a number (--base,
   --diff) are one PR, "the changes", whose versions are every such attachment.

   A verdict names the PRs it is about (`prs`). One that names none is about every PR on the
   thread at that moment, except an approval when there were several: that one approves none. */
import type { Message, Verdict } from "./types";

export interface PrState {
  key: string; // "#2450", or "changes" for a diff without a number
  number: number | null;
  title: string | null;
  att: string; // the newest version's attachment id: what opens
  versions: number;
  head_sha: string | null;
  diff_blob: string | null;
  verdict: Verdict | null; // the deciders' latest on this PR, cleared by a newer version
  by: string | null;
  at: string | null;
  approved?: { head_sha: string; diff_blob: string }; // exactly what an approval approved
}

export const prKey = (n: number | null | undefined) => (n ? `#${n}` : "changes");

export function prStates(messages: Message[], deciders: string[]): PrState[] {
  const by = new Map<string, PrState>();
  for (const m of messages) {
    for (const a of m.attachments) {
      if (a.type !== "pr") continue;
      const key = prKey(a.meta.number);
      const was = by.get(key);
      by.set(key, {
        key, number: a.meta.number ?? null, title: a.meta.title ?? was?.title ?? null, att: a.id, versions: (was?.versions ?? 0) + 1,
        head_sha: a.meta.head_sha ?? null, diff_blob: a.meta.diff_blob ?? null,
        verdict: null, by: null, at: null, // a new version needs a new verdict
      });
    }
    if (!m.verdict || !deciders.includes(m.author)) continue;
    const named = (m.prs ?? []).map(prKey).filter((k) => by.has(k));
    // An approval naming no PR, on a thread already carrying several, cannot say which one the
    // person looked at: it approves none. Dak refuses to write these now; older ones exist, and
    // reading them as "all" is exactly how one approval passed for sixteen.
    if (!named.length && by.size > 1 && m.verdict === "approve") continue;
    for (const key of named.length ? named : [...by.keys()]) {
      const s = by.get(key)!;
      const approved = m.verdict === "approve" ? m.approved_heads?.[key] ?? (named.length <= 1 && by.size === 1 ? m.approved : undefined) : undefined;
      by.set(key, { ...s, verdict: m.verdict, by: m.author, at: m.created_at, approved });
    }
  }
  return [...by.values()];
}

/* Is everything on the thread approved by this reader, with nothing new since? For a thread with
   PRs: every PR's latest verdict is an approval. For one without (a doc, a note): the reader's
   last verdict was an approval and nobody attached anything after it. */
export function approvedNow(messages: Message[], reader: string): boolean {
  const prs = prStates(messages, [reader]);
  if (prs.length) return prs.every((p) => p.verdict === "approve");
  let ok = false;
  for (const m of messages) {
    if (m.author === reader && m.verdict) ok = m.verdict === "approve";
    else if (m.author !== reader && m.attachments.length) ok = false;
  }
  return ok;
}

// "approved #2450, #2451" or "approved", for the one-line summaries agents read.
export function verdictLabel(m: Pick<Message, "verdict" | "prs">): string {
  if (!m.verdict) return "";
  const word = { approve: "approved", changes: "changes requested", question: "question" }[m.verdict];
  return m.prs?.length ? `${word} ${m.prs.map((n) => `#${n}`).join(", ")}` : word;
}

// "3 of 16 approved: #2450, #2451, #2452", for a thread carrying several PRs; "" for one.
export function approvedSummary(prs: PrState[]): string {
  if (prs.length < 2) return "";
  const ok = prs.filter((p) => p.verdict === "approve");
  return `${ok.length} of ${prs.length} PRs approved${ok.length ? `: ${ok.map((p) => p.key).join(", ")}` : ""}`;
}
