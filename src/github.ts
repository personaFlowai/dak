import type { Anchor, Comment, PrMeta, Verdict } from "./types";
import { DakError } from "./types";

// Mirroring a review to GitHub is the person's choice, per send: Dak only builds
// the review and hands it to `gh`, which already holds their GitHub login.

export function prCoordinates(meta: PrMeta): { owner: string; repo: string; number: number } | null {
  const m = meta.url?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export function reviewPayload(meta: PrMeta, body: string, verdict: Verdict | null, comments: { anchor: Anchor | null; body: string }[]) {
  const event = verdict === "approve" ? "APPROVE" : verdict === "changes" ? "REQUEST_CHANGES" : "COMMENT";
  const inline = comments.filter((c) => c.anchor?.kind === "code").map((c) => {
    const a = c.anchor as Extract<Anchor, { kind: "code" }>;
    const side = a.side === "old" ? "LEFT" : "RIGHT";
    return { path: a.file, line: a.end_line, side, ...(a.end_line > a.start_line ? { start_line: a.start_line, start_side: side } : {}), body: c.body };
  });
  return {
    ...(meta.head_sha ? { commit_id: meta.head_sha } : {}),
    // GitHub refuses an empty body on anything but APPROVE.
    body: body.trim() || (event === "APPROVE" ? "" : "Review from Dak."),
    event,
    comments: inline,
  };
}

export async function postReview(meta: PrMeta, body: string, verdict: Verdict | null, comments: Pick<Comment, "anchor" | "body">[]): Promise<{ url: string; event: string; note?: string }> {
  const at = prCoordinates(meta);
  if (!at) throw new DakError("not_github", "This PR did not come from GitHub, so there is nowhere to post the review.");
  const payload = reviewPayload(meta, body, verdict, comments);
  const send = async (p: typeof payload) => {
    const proc = Bun.spawn(["gh", "api", "-X", "POST", `repos/${at.owner}/${at.repo}/pulls/${at.number}/reviews`, "--input", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify(p));
    proc.stdin.end();
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  };
  let r = await send(payload);
  // You cannot approve or request changes on your own PR, which is the usual case
  // when an agent opens PRs as you. Post the same review as a comment instead.
  if (r.code !== 0 && payload.event !== "COMMENT" && /own pull request/i.test(r.out + r.err)) {
    r = await send({ ...payload, event: "COMMENT", body: `${payload.event === "APPROVE" ? "Approved" : "Changes requested"} in Dak.\n\n${payload.body}`.trim() });
    if (r.code === 0) return { url: JSON.parse(r.out).html_url, event: "COMMENT", note: "GitHub does not let you approve your own PR, so it was posted as a comment." };
  }
  if (r.code !== 0) {
    const msg = (() => { try { return JSON.parse(r.out).message; } catch { return r.err.trim().split("\n").pop(); } })();
    throw new DakError("github_failed", `GitHub refused the review: ${msg || "gh exited with " + r.code}.`, 502);
  }
  return { url: JSON.parse(r.out).html_url, event: payload.event };
}
