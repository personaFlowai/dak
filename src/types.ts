// The protocol's shapes. Everything an agent sends or receives is one of these,
// serialised as JSON by the CLI (--json) and the HTTP API alike.

export type ThreadKind = "pr" | "doc" | "note";
// informed: the sender said no reply is needed (an update, a heads-up).
export type ThreadStatus = "waiting" | "answered" | "picked_up" | "informed" | "closed";
export type Verdict = "approve" | "changes" | "question";

export interface Reader {
  name: string;
  kind: "person" | "agent";
}

export interface Thread {
  id: string;
  to: string;
  from: string;
  subject: string;
  kind: ThreadKind;
  status: ThreadStatus;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number; // global, increasing: doubles as the cursor for polling
  thread_id: string;
  author: string;
  body: string;
  verdict: Verdict | null;
  created_at: string;
  attachments: Attachment[];
  comments: Comment[];
  options?: string[]; // buttons the reader can answer with, in the sender's order
  choice?: string; // on a reply: the option the reader picked
  handoff?: Handoff; // "ready for review": the head and the proofs, checked at send time
  cost?: Cost; // what the ask spends if the reader says yes
  reviewing?: boolean; // the reader saying "I'm on it": the thread stays on them until their verdict
  approved?: { head_sha: string; diff_blob: string }; // on an approval: exactly what was approved
  prs?: number[]; // the PRs a verdict is about; none named means every PR on the thread
  quiet?: boolean; // an update that needs no reply: delivered at the next turn, never wakes or interrupts
  mentions?: string[]; // the team members @mentioned in it; each was brought onto the topic
  answers?: string; // a mentioned member's reply: who mentioned it, so only they are woken
  left?: boolean; // that member left the topic with this reply
  everyone?: boolean; // @all in a group: every member is woken
  moved?: { work: string; thread: string }; // "Make it work" moved a message from here to that piece's topic
  waits?: { until: string }; // the author is waiting for the answer, until then
  approved_heads?: Record<string, { head_sha: string; diff_blob: string }>; // per PR ("#2450"), what each approval approved
  tryit?: { ticket?: string }; // a "try it" note: its first button means it works
  tryit_result?: { result: "works" | "wrong"; ticket?: string }; // the person's pick on one
}

// Who else is on a thread, and why. The sender is the author and the addressee is asked
// first; these are everyone else.
export type Role = "author" | "reviewer" | "approver" | "watcher" | "member";
export const ROLES: Role[] = ["author", "reviewer", "approver", "watcher", "member"];
export interface Participant { name: string; role: Role }

export interface Proof { name: string; result: "pass" | "fail"; count?: number }
export interface Handoff {
  head: string; // the commit the proofs ran on
  base: string | null;
  migration: string; // its file name, or "none"
  proofs: Proof[];
  skipped: { name: string; reason: string }[];
}
export interface Cost { estimate: number; cap?: number; currency: string }
export interface MessageExtra { handoff?: Handoff; cost?: Cost; reviewing?: boolean; parked?: boolean;
  approved?: { head_sha: string; diff_blob: string }; // what an approval approved, recorded by Dak
  prs?: number[]; // the PRs a verdict is about
  quiet?: boolean; // an update that needs no reply
  mentions?: string[];
  answers?: string;
  left?: boolean;
  everyone?: boolean;
  moved?: { work: string; thread: string };
  waits?: { until: string };
  approved_heads?: Record<string, { head_sha: string; diff_blob: string }>;
  tryit?: { ticket?: string }; // a "try it" note on a live feature: its first button means it works
  tryit_result?: { result: "works" | "wrong"; ticket?: string }; // the person's pick on one
}

export type Attachment = (
  | { id: string; type: "pr"; name: string; meta: PrMeta }
  | { id: string; type: "doc"; name: string; meta: DocMeta }
  | { id: string; type: "file"; name: string; meta: FileMeta }
  | { id: string; type: "link"; name: string; meta: { url: string } }
) & { hidden?: boolean }; // taken off the topic by the person (a merged PR): kept, but out of the way

export interface PrMeta {
  url: string | null;
  number: number | null;
  title: string | null;
  repo: string | null; // local path the diff came from, used by Explain
  base_sha: string | null;
  head_sha: string | null;
  base_ref?: string;
  // The PR this one is stacked on, so a reader approves them in order.
  stacked_on?: { branch: string; number?: number; url?: string; title?: string; thread?: string };
  diff_blob: string;
  files: PrFile[];
  chapters: Chapter[];
  prologue?: Prologue;
}

export interface Prologue {
  why?: string; // the problem, in plain words
  what?: string; // what the PR does about it
  focus?: string[]; // where the reviewer should spend their attention
}

export interface PrFile {
  path: string;
  old_path: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  additions: number;
  deletions: number;
  new_blob: string | null; // whole file at head, so the file view outlives the branch
}

export interface Chapter {
  title: string;
  summary: string;
  risk: "low" | "medium" | "high";
  risk_why?: string;
  // The context a reviewer needs beyond the code. All optional; check() asks for proof on a high-risk chapter.
  why?: string; // why this part of the change exists
  check?: string[]; // what to check: concrete questions to answer while reading
  proof?: string; // how the risk is proven: the test, the run, the number
  noticed?: string; // what a person using the product will notice, or that nothing visible changes
  reviewer_note?: { by: string; text: string }; // from whoever read the code, if not the author
  hunks: { file: string; start: number }[];
  key_changes?: { text: string; file: string; side?: "old" | "new"; line: number }[];
  big_why?: string; // why a chapter is bigger than a reader can hold (over 6 files or 12 hunks), when it must be
}

export interface DocMeta {
  blob: string;
  version: number;
}

export interface FileMeta {
  blob: string;
  size: number;
  mime: string;
}

export type Anchor =
  | { kind: "code"; file: string; side: "old" | "new"; start_line: number; end_line: number }
  | { kind: "doc"; version: number; block_index: number; block_hash: string; quote: string; exact?: boolean }; // exact: quote is words the reader selected

export interface Comment {
  id: number;
  thread_id: string;
  message_id: number;
  attachment_id: string | null;
  author: string;
  anchor: Anchor | null;
  body: string;
}

export class DakError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}
