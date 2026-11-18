import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff } from "../src/diff";

// Every test goes through the real CLI or the real HTTP server, into a real
// SQLite file in a throwaway DAK_HOME, and is scored by what ended up there.
const home = mkdtempSync(join(tmpdir(), "dak-test-"));
const repo = mkdtempSync(join(tmpdir(), "dak-repo-"));
const PORT = 17000 + Math.floor(Math.random() * 2000);
process.env.DAK_HOME = home;
process.env.DAK_PORT = String(PORT);
// Connecting a tool installs the Dak instructions; keep them out of the real home folder.
process.env.DAK_CLAUDE_SKILLS = join(home, "claude-skills");
process.env.DAK_CODEX_AGENTS = join(home, "codex-AGENTS.md");
process.env.DAK_CLAUDE_SETTINGS = join(home, "claude-settings.json");
process.env.DAK_CODEX_HOOKS = join(home, "codex-hooks.json");
process.env.DAK_CURSOR_HOOKS = join(home, "cursor-hooks.json");
// The server's wake ticker would take other tests' mail; the wake test drives it by hand.
process.env.DAK_NO_WAKE = "1";
process.env.DAK_NO_LINEAR = "1"; // never call Linear from a test
process.env.DAK_CLAUDE_SESSIONS = join(home, "claude-sessions");
process.env.DAK_WAKE_GRACE_MS = "0";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function dak(...args: string[]) {
  const p = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, DAK_HOME: home }, cwd: repo, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), json: () => JSON.parse(p.stdout.toString()) };
}
function git(...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}

let server: ReturnType<typeof import("../src/server").serve>;
let token = "";
const base = `http://127.0.0.1:${PORT}`;
const http = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

beforeAll(async () => {
  expect(dak("init", "--readers", "sam:person,atlas,mitra,zari").code).toBe(0);
  // A fake helper stands in for claude -p, so no test ever calls a model.
  const cfg = readFileSync(join(home, "config.toml"), "utf8").replace(/^command = .*$/m,
    `command = ["sh", "-c", "echo EXPLAINED; echo \\"$0\\" | grep -c 'Selected:'"]`);
  writeFileSync(join(home, "config.toml"), cfg);
  const { serve } = await import("../src/server");
  server = serve(PORT);
  token = readFileSync(join(home, "token"), "utf8").trim();

  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
  writeFileSync(join(repo, "taps.ts"), "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n");
  git("add", "."); git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  writeFileSync(join(repo, "taps.ts"), "export function a() {\n  return 10;\n}\n\nexport function b() {\n  return 2;\n}\n");
  writeFileSync(join(repo, "service.ts"), "// new service\nexport const markDone = () => true;\n");
  git("add", "."); git("commit", "-qm", "change");
});

afterAll(() => {
  server?.stop(true);
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("sending and readers", () => {
  test("a message to someone who is not a reader is refused, naming the readers", () => {
    const r = dak("send", "--to", "nobody", "--from", "grok", "hello", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("unknown_reader");
    expect(r.json().error.message).toContain("sam, atlas, mitra, zari");
  });

  test("a note from any sender lands in the reader's inbox as unread", () => {
    const sent = dak("send", "--to", "zari", "--from", "grok", "--subject", "Hooks for reel 3", "Three options", "--json").json();
    const inbox = dak("inbox", "--for", "zari", "--json").json();
    const row = inbox.find((t: any) => t.id === sent.thread.id);
    expect(row.unread).toBe(1);
    expect(row.status).toBe("waiting");
    const msgs = dak("inbox", "--for", "zari", "--unread", "--json").json();
    expect(msgs.map((m: any) => m.body)).toContain("Three options");
    // Reading once marks it read.
    expect(dak("inbox", "--for", "zari", "--unread", "--json").json()).toEqual([]);
  });
});

describe("the two-way loop", () => {
  test("a reply with a verdict and anchored comments reaches the waiting agent, and the thread shows it was picked up", async () => {
    writeFileSync(join(repo, "brief.md"), "# Staff see their day\n\nFirst paragraph.\n\nSecond paragraph.\n");
    const { thread } = dak("send", "--to", "sam", "--from", "mitra", "--doc", "brief.md", "Please review", "--json").json();
    expect(thread.kind).toBe("doc");
    expect(thread.subject).toBe("Staff see their day");

    const waiting = Bun.spawn(["bun", CLI, "wait", thread.id, "--for", "mitra", "--timeout", "20s", "--json"], { env: { ...process.env, DAK_HOME: home }, stdout: "pipe" });
    await Bun.sleep(400);
    const res = await http(`/v1/threads/${thread.id}/messages`, { method: "POST", body: JSON.stringify({
      author: "sam", body: "Close. One question.", verdict: "changes",
      comments: [{ attachment_id: null, anchor: { kind: "doc", version: 1, block_index: 2, block_hash: "abc", quote: "Second paragraph." }, body: "Why second?" }] }) });
    expect(res.status).toBe(201);

    const started = Date.now();
    const out = JSON.parse(await new Response(waiting.stdout).text());
    expect(await waiting.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.messages[0].verdict).toBe("changes");
    expect(out.messages[0].comments[0].body).toBe("Why second?");
    expect(out.messages[0].comments[0].anchor.quote).toBe("Second paragraph.");
    expect(dak("show", thread.id, "--json").json().thread.status).toBe("picked_up");
  });

  test("wait gives up after its timeout with exit code 2", () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Quiet", "x", "--json").json();
    const r = dak("wait", thread.id, "--for", "atlas", "--timeout", "1s", "--json");
    expect(r.code).toBe(2);
    expect(r.json().timed_out).toBe(true);
  });

  test("a second doc with the same name is the next version", () => {
    const { thread } = dak("send", "--to", "sam", "--from", "mitra", "--doc", "brief.md", "--json").json();
    dak("reply", thread.id, "--from", "mitra", "--doc", "brief.md", "v2 attached");
    const t = dak("show", thread.id, "--json").json();
    const versions = t.messages.flatMap((m: any) => m.attachments).map((a: any) => a.meta.version);
    expect(versions).toEqual([1, 2]);
    expect(t.thread.status).toBe("waiting");
  });

  test("after an approval, an update does not put the thread back on the reader; a new version or a question does", () => {
    const status = (id: string) => dak("show", id, "--json").json().thread.status;
    const { thread } = dak("send", "--to", "sam", "--from", "mitra", "--doc", "brief.md", "--json").json();
    dak("reply", thread.id, "--from", "sam", "--verdict", "approve", "Go.");
    dak("reply", thread.id, "--from", "mitra", "Merged.");
    expect(status(thread.id)).toBe("answered");
    dak("reply", thread.id, "--from", "mitra", "--verdict", "question", "Also the README?");
    expect(status(thread.id)).toBe("waiting");
    dak("reply", thread.id, "--from", "sam", "--verdict", "approve", "Yes.");
    dak("reply", thread.id, "--from", "mitra", "--doc", "brief.md", "v2");
    expect(status(thread.id)).toBe("waiting");
  });

  test("--fyi sends without asking for a reply, and a reply marked --fyi leaves a waiting thread waiting", () => {
    const { thread } = dak("send", "--to", "sam", "--from", "mitra", "--subject", "Heads-up", "--fyi", "Deploy at 9.", "--json").json();
    expect(thread.status).toBe("informed");
    const q = dak("send", "--to", "sam", "--from", "mitra", "--subject", "Pick one", "A or B?", "--json").json().thread;
    dak("reply", q.id, "--from", "mitra", "--fyi", "No rush.");
    expect(dak("show", q.id, "--json").json().thread.status).toBe("waiting");
  });
});

describe("waking an idle Claude Code session", () => {
  const wake = (session: string, pid = process.pid) => http("/v1/wake", { method: "POST", headers: { "x-dak-pid": String(pid) },
    body: JSON.stringify({ cwd: "/tmp/somewhere", session_id: session, hook_event_name: "Stop" }) });

  test("a waiting session gets its mail the moment it arrives; a newer waiter releases the older; a closed session gets nothing", async () => {
    process.env.DAK_NAME = "zari";
    try {
      const older = wake("s1");
      await Bun.sleep(300);
      const newer = wake("s1");
      expect((await older).status).toBe(204);
      await Bun.sleep(300);
      dak("send", "--to", "zari", "--from", "sam", "--subject", "Reel cut 5", "Is the hook right?");
      const got = await newer;
      expect(got.status).toBe(200);
      expect(await got.text()).toContain("Reel cut 5");
      // The process that would read it is gone: the mail stays unread for the next session.
      dak("send", "--to", "zari", "--from", "sam", "--subject", "Later", "x");
      expect((await wake("s2", 999999)).status).toBe(204);
      expect(dak("inbox", "--for", "zari", "--unread", "--peek", "--json").json().length).toBe(1);
    } finally { delete process.env.DAK_NAME; }
  });
});

describe("teaching agents to use Dak", () => {
  test("connecting installs the skill for Claude Code and a marked section for Codex; disconnecting removes only those", async () => {
    const agents = process.env.DAK_CODEX_AGENTS!, skill = join(process.env.DAK_CLAUDE_SKILLS!, "dak", "SKILL.md");
    writeFileSync(agents, "# My rules\n\nBe brief.\n");
    await http("/v1/connect/claude", { method: "POST" });
    await http("/v1/connect/codex", { method: "POST" });
    expect(readFileSync(skill, "utf8")).toContain("name: dak");
    const withDak = readFileSync(agents, "utf8");
    expect(withDak).toContain("# My rules");
    expect(withDak).toContain("## Dak");
    await http("/v1/connect/codex", { method: "POST" }); // connecting twice leaves one section
    expect(readFileSync(agents, "utf8").split("## Dak").length).toBe(2);
    await http("/v1/connect/claude", { method: "DELETE" });
    await http("/v1/connect/codex", { method: "DELETE" });
    expect(readFileSync(agents, "utf8")).toBe("# My rules\n\nBe brief.\n");
    expect(Bun.file(skill).size).toBe(0);
    expect(dak("skill", "--plain").out).toContain("dak send");
  });
});

describe("Codex sessions have names of their own", () => {
  test("a Codex worktree gets <folder>-codex-<id>; send and inbox fill it in; the hook delivers to the same name", () => {
    const wt = join(home, ".codex", "worktrees", "bc25", "shop");
    require("node:fs").mkdirSync(wt, { recursive: true });
    const env = { ...process.env, DAK_HOME: home, DAK_TOOL: "codex", CLAUDE_CODE_SESSION_ID: "", CLAUDECODE: "" };
    const run = (...args: string[]) => Bun.spawnSync(["bun", CLI, ...args], { env, cwd: wt, stdout: "pipe", stderr: "pipe" });
    expect(run("whoami").stdout.toString().trim()).toBe("shop-codex-bc25");
    const sent = JSON.parse(run("send", "--to", "sam", "--subject", "From Codex", "hi", "--json").stdout.toString());
    expect(sent.thread.from).toBe("shop-codex-bc25");
    dak("reply", sent.thread.id, "--from", "sam", "Got it, Codex");
    expect(JSON.parse(run("inbox", "--unread", "--peek", "--json").stdout.toString())[0].body).toBe("Got it, Codex");
    const hook = Bun.spawnSync(["bun", CLI, "hook", "codex"], { env: { ...process.env, DAK_HOME: home },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: wt })), stdout: "pipe" });
    expect(hook.stdout.toString()).toContain("Got it, Codex");
  });
});

describe("keep Codex listening", () => {
  test("off: Codex's Stop hook returns at once; on: it waits and hands over mail that arrives later", async () => {
    const wt = join(home, ".codex", "worktrees", "zz11", "shop");
    require("node:fs").mkdirSync(wt, { recursive: true });
    const stop = () => Bun.spawn(["bun", CLI, "hook", "codex"], { env: { ...process.env, DAK_HOME: home, DAK_LISTEN_MS: "6000" },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "Stop", cwd: wt })), stdout: "pipe" });
    await http("/v1/settings", { method: "PUT", body: JSON.stringify({ codex_listen: false }) });
    let t0 = Date.now(), p = stop();
    expect(await new Response(p.stdout).text()).toBe("");
    expect(Date.now() - t0).toBeLessThan(3000);
    const on = await (await http("/v1/settings", { method: "PUT", body: JSON.stringify({ codex_listen: true }) })).json();
    expect(on.codex_listen).toBe(true);
    p = stop();
    await Bun.sleep(1500);
    dak("send", "--to", "shop-codex-zz11", "--from", "sam", "--subject", "Late mail", "Please check the totals.");
    const out = JSON.parse(await new Response(p.stdout).text());
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("Please check the totals.");
    await http("/v1/settings", { method: "PUT", body: JSON.stringify({ codex_listen: false }) });
  });
});

describe("the Ask helper is not an agent", () => {
  test("hooks inside Dak's own helper record nothing and deliver nothing", () => {
    const input = new TextEncoder().encode(JSON.stringify({ hook_event_name: "SessionStart", cwd: "/tmp/dak-ask-zz9", session_id: "helper-1" }));
    const p = Bun.spawnSync(["bun", CLI, "hook", "codex"], { env: { ...process.env, DAK_HOME: home, DAK_HELPER: "1" }, stdin: input, stdout: "pipe" });
    expect(p.stdout.toString()).toBe("");
    expect(dak("agents", "--json").json().some((a: any) => a.name.startsWith("dak-ask-"))).toBe(false);
  });
});

describe("session names", () => {
  test("a Claude Code session that sends as a name gets that name's mail, whatever its folder", () => {
    const env = { ...process.env, DAK_HOME: home, CLAUDE_CODE_SESSION_ID: "sess-claim-1" };
    const r = Bun.spawnSync(["bun", CLI, "send", "--to", "sam", "--from", "mitra", "--subject", "Claimed", "hi", "--json"], { env, cwd: repo, stdout: "pipe" });
    const thread = JSON.parse(r.stdout.toString()).thread;
    dak("reply", thread.id, "--from", "sam", "Got it");
    const hook = Bun.spawnSync(["bun", CLI, "hook", "claude-code"], { env: { ...process.env, DAK_HOME: home },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/some-other-folder", session_id: "sess-claim-1" })), stdout: "pipe" });
    expect(hook.stdout.toString()).toContain("Got it");
  });

  test("looking at another reader's inbox does not change who the session is", () => {
    const env = { ...process.env, DAK_HOME: home, CLAUDE_CODE_SESSION_ID: "sess-claim-2" };
    Bun.spawnSync(["bun", CLI, "send", "--to", "sam", "--from", "zari", "--subject", "Mine", "x"], { env, cwd: repo });
    Bun.spawnSync(["bun", CLI, "inbox", "--for", "mitra", "--unread", "--peek", "--json"], { env, cwd: repo });
    const r = dak("send", "--to", "zari", "--from", "sam", "--subject", "For zari", "hello", "--json");
    expect(r.code).toBe(0);
    const hook = Bun.spawnSync(["bun", CLI, "hook", "claude-code"], { env: { ...process.env, DAK_HOME: home },
      stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/x", session_id: "sess-claim-2" })), stdout: "pipe" });
    expect(hook.stdout.toString()).toContain("For zari"); // still zari, not mitra
  });
});

describe("done topics", () => {
  test("a topic marked done is closed until a new version or a question puts it back on the reader", async () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--doc", "brief.md", "--json").json();
    const done = await (await http(`/v1/threads/${thread.id}/done`, { method: "POST", body: JSON.stringify({ done: true }) })).json();
    expect(done.status).toBe("closed");
    dak("reply", thread.id, "--from", "atlas", "--fyi", "Merged.");
    expect(dak("show", thread.id, "--json").json().thread.status).toBe("closed");
    dak("reply", thread.id, "--from", "atlas", "--doc", "brief.md", "v2");
    expect(dak("show", thread.id, "--json").json().thread.status).toBe("waiting");
  });
});

describe("search", () => {
  test("finds words in messages and in a PR's chapter notes, with a readable snippet", async () => {
    dak("send", "--to", "sam", "--from", "zari", "--subject", "Reel", "The kumquat frame is ready", "--json");
    const hits = await (await http("/v1/search?q=kumquat")).json();
    expect(hits[0].subject).toBe("Reel");
    expect(hits[0].text).toContain("kumquat frame");
    dak("send", "--to", "sam", "--from", "mitra", "--doc", "brief.md", "--subject", "Plan", "--json");
    const doc = await (await http("/v1/search?q=brief.md")).json();
    expect(doc.length).toBeGreaterThan(0);
    expect(doc[0].text).not.toContain("{"); // the file's name, not its stored record
    expect(await (await http("/v1/search?q=a")).json()).toEqual([]);
  });
});

describe("agents close their own topics", () => {
  test("reply --done leaves a note and closes the topic; a later question reopens it", () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--subject", "PR 9", "Please review", "--json").json();
    dak("reply", thread.id, "--from", "sam", "--verdict", "approve", "Go");
    dak("reply", thread.id, "--from", "atlas", "--done", "Merged as abc123");
    const t = dak("show", thread.id, "--json").json();
    expect(t.thread.status).toBe("closed");
    expect(t.messages.at(-1).body).toBe("Merged as abc123");
    dak("reply", thread.id, "--from", "atlas", "--verdict", "question", "Revert?");
    expect(dak("show", thread.id, "--json").json().thread.status).toBe("waiting");
  });
});

describe("archive", () => {
  test("a conversation can be archived and brought back, and the record survives in the store", async () => {
    const call = (method: string, body?: any) => fetch(`${base}/v1/archives`, { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
    const after = await call("PUT", { peer: "atlas" });
    expect(Object.keys(after)).toContain("atlas");
    expect(Object.keys(await call("GET"))).toContain("atlas");
    expect(Object.keys(await call("DELETE", { peer: "atlas" }))).not.toContain("atlas");
  });
});

describe("buttons", () => {
  test("an agent offers buttons; the reader's pick comes back as the choice, and an unknown pick is refused", async () => {
    const { thread, message } = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Merge order", "Which first?",
      "--option", "#2401 first", "--option", "#2402 first", "--option", "#2401 first", "--fyi", "--json").json();
    expect(message.options).toEqual(["#2401 first", "#2402 first"]);
    expect(thread.status).toBe("waiting"); // buttons are a question, whatever --fyi says
    const post = (choice: string) => fetch(`${base}/v1/threads/${thread.id}/messages`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ author: "sam", body: "", choice }) });
    expect((await post("#2403 first")).status).toBe(400);
    expect((await post("#2402 first")).status).toBe(201);
    const r = dak("wait", thread.id, "--for", "atlas", "--timeout", "2s", "--json").json();
    expect(r.messages[0].choice).toBe("#2402 first");
  });
});

describe("agent-to-agent work", () => {
  test("a shared thread: a reviewer added with --cc gets the mail, answers it, and show names where each person stands", () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--cc", "mitra:reviewer", "--subject", "Shared", "Look at this", "--json").json();
    const got = dak("inbox", "--for", "mitra", "--unread", "--json").json();
    expect(got.map((m: any) => m.thread_id)).toContain(thread.id);
    dak("reply", thread.id, "--from", "mitra", "Two findings.");
    const t = dak("show", thread.id, "--json").json();
    expect(t.participants).toEqual([{ name: "mitra", role: "reviewer" }]);
    expect(t.thread.status).toBe("waiting"); // the reviewer's findings do not answer for sam
    const line = dak("show", thread.id).out;
    expect(line).toContain("mitra (reviewer) replied");
    expect(line).toContain("sam has not opened it");
    // Added later, an approver gets the whole thread as new mail.
    expect(dak("add", thread.id, "zari:approver").code).toBe(0);
    expect(dak("inbox", "--for", "zari", "--unread", "--json").json().filter((m: any) => m.thread_id === thread.id).length).toBe(2);
    expect(dak("add", thread.id, "zari:boss", "--json").json().error.code).toBe("bad_role");
  });

  test("a group: one message reaches every member, and each ack shows", () => {
    expect(dak("group", "set", "eng", "mitra", "zari").code).toBe(0);
    expect(dak("send", "--to", "group:nobody", "--from", "atlas", "--subject", "x", "y", "--json").json().error.code).toBe("unknown_group");
    const { thread } = dak("send", "--to", "group:eng", "--from", "atlas", "--fyi", "--subject", "Load 67", "Stop your stacks", "--json").json();
    for (const who of ["mitra", "zari"]) expect(dak("inbox", "--for", who, "--unread", "--peek", "--json").json().some((m: any) => m.thread_id === thread.id)).toBe(true);
    dak("ack", thread.id, "--from", "zari", "Stopped.");
    const line = dak("show", thread.id).out;
    expect(line).toContain("zari (member) replied");
    expect(line).toContain("mitra (member) has not opened it");
    expect(dak("wait", thread.id, "--for", "atlas", "--timeout", "2s", "--json").json().messages[0].body).toBe("Stopped.");
  });

  test("a priced question records the decision with its cost", async () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Run the evals?", "Three arms.",
      "--option", "Run it", "--option", "Not now", "--cost", "0.15", "--cap", "0.25", "--json").json();
    expect(dak("show", thread.id).out).toContain("Costs about $0.15, capped at $0.25");
    expect(dak("send", "--to", "sam", "--from", "atlas", "--subject", "x", "y", "--cost", "0.3", "--cap", "0.2", "--json").json().error.code).toBe("bad_cost");
    await fetch(`${base}/v1/threads/${thread.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ author: "sam", body: "", choice: "Run it" }) });
    const d = dak("decisions", "--for", "sam", "--json").json().find((x: any) => x.thread_id === thread.id);
    expect(d).toMatchObject({ choice: "Run it", asked_by: "atlas", question: "Three arms.", cost: { estimate: 0.15, cap: 0.25, currency: "USD" } });
  });
});

describe("merge queue", () => {
  beforeAll(() => writeFileSync(join(repo, "d2.diff"), "diff --git a/q.ts b/q.ts\n--- a/q.ts\n+++ b/q.ts\n@@ -1 +1 @@\n-a\n+b\n"));
  test("merge scripts push state; the queue keeps join order and refuses an unknown state", async () => {
    expect(dak("queue", "set", "2427", "--state", "approved", "--head", "abc1234", "--migration", "20261116_x.sql", "--title", "Needs-you").code).toBe(0);
    dak("queue", "set", "#2425", "--state", "approved", "--title", "Register reads");
    dak("queue", "set", "2427", "--state", "testing", "--note", "full suite, 4 min");
    expect(dak("queue", "set", "2427", "--state", "shipped", "--json").json().error.code).toBe("bad_state");
    let rows = dak("queue", "--json").json();
    expect(rows.map((r: any) => [r.pr, r.state])).toEqual([[2427, "testing"], [2425, "approved"]]);
    expect(rows[0]).toMatchObject({ head: "abc1234", migration: "20261116_x.sql", note: "full suite, 4 min" });
    dak("queue", "set", "2427", "--state", "deployed");
    rows = (await (await http("/v1/queue")).json()) as any[];
    expect(rows.map((r: any) => [r.pr, r.state])).toEqual([[2427, "deployed"], [2425, "approved"]]); // join order; the page groups them
    expect(rows[1].note).toBeNull(); // a new state clears the old note
  });

  test("each row knows how long it has been at its step, its estimate, what it waits for, and whether the person really approved it", async () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--diff", "d2.diff", "--subject", "Timed", "--json").json();
    const r0 = dak("queue", "set", "3001", "--state", "testing", "--eta", "4m", "--after", "#2425", "--thread", thread.id, "--json").json();
    expect(Math.round((Date.parse(r0.eta_at) - Date.parse(r0.state_since)) / 60000)).toBe(4);
    expect(r0.after_pr).toBe(2425);
    expect(r0.approval).toBeNull(); // the queue says approved; the thread has no approval from sam
    await fetch(`${base}/v1/threads/${thread.id}/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ author: "sam", body: "", verdict: "approve" }) });
    const r1 = dak("queue", "set", "3001", "--note", "4 of 9 files", "--json").json();
    expect(r1.approval.by).toBe("sam");
    expect(r1.state_since).toBe(r0.state_since); // same step, same clock
    expect(r1.eta_at).toBe(r0.eta_at);
    const r2 = dak("queue", "set", "3001", "--state", "building", "--after", "none", "--json").json();
    expect([r2.eta_at, r2.after_pr, r2.note]).toEqual([null, null, null]);
  });

  test("I'm reviewing: the sender hears, the PR stays waiting on the reader, and the queue lists it until the verdict", async () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--diff", "d2.diff", "--subject", "Look at me", "--json").json();
    let mine = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    expect(mine.find((r) => r.thread_id === thread.id)?.reviewing_since).toBeNull();
    expect((await http(`/v1/threads/${thread.id}/reviewing`, { method: "POST", body: JSON.stringify({ author: "sam" }) })).status).toBe(201);
    expect(dak("wait", thread.id, "--for", "atlas", "--timeout", "2s", "--json").json().messages[0].body).toBe("Reviewing this now.");
    expect(dak("show", thread.id, "--json").json().thread.status).toBe("waiting");
    expect(dak("show", thread.id).out).toContain("sam is reviewing it, since");
    mine = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    expect(mine.find((r) => r.thread_id === thread.id)?.reviewing_since).toBeTruthy();
    dak("reply", thread.id, "--from", "sam", "--verdict", "approve", "Fine.");
    mine = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    expect(mine.find((r) => r.thread_id === thread.id)).toBeUndefined();
  });
});

describe("priorities", () => {
  test("tiers then order; next skips what waits or is held; an order against --after is refused; pairs merge together", () => {
    for (const [pr, extra] of [[4001, []], [4002, ["--after", "4001"]], [4003, []], [4004, []], [4005, []]] as [number, string[]][]) {
      dak("queue", "set", String(pr), "--state", "approved", "--title", `P${pr}`, ...extra);
    }
    expect(dak("queue", "order", "4002", "4001", "--from", "atlas", "--json").json().error.code).toBe("order_conflict");
    expect(dak("queue", "order", "4003", "4001", "4002", "--from", "atlas").code).toBe(0);
    dak("queue", "set", "4004", "--tier", "urgent", "--why", "production bug", "--from", "atlas");
    const ours = dak("queue", "--json").json().filter((r: any) => r.pr > 4000).map((r: any) => r.pr);
    expect(ours.slice(0, 4)).toEqual([4004, 4003, 4001, 4002]);
    expect(dak("queue", "next", "--json").json().next.map((r: any) => r.pr)).toEqual([4004]);
    dak("queue", "set", "4004", "--state", "held", "--waiting", "a migration renumber");
    expect(dak("queue", "--json").json().find((r: any) => r.pr === 4004).waiting_reason).toBe("a migration renumber");
    expect(dak("queue", "next", "--json").json().next.map((r: any) => r.pr)).toEqual([4003]);
    // 4002 waits for 4001; it is not next even when ordered first, and says why.
    expect(dak("queue", "--json").json().find((r: any) => r.pr === 4002).waiting_reason).toBe("Waiting on #4001 (approved)");
    dak("queue", "pair", "4003", "4005");
    expect(dak("queue", "next", "--json").json().next.map((r: any) => r.pr).sort()).toEqual([4003, 4005]);
    dak("queue", "set", "4005", "--state", "testing");
    expect(dak("queue", "--json").json().find((r: any) => r.pr === 4003).waiting_reason).toBe("Waiting on its pair #4005 (testing)");
  });

  test("the person's order wins: an agent's reorder leaves the rows the person placed", async () => {
    await http("/v1/queue/order", { method: "PUT", body: JSON.stringify({ prs: [4002, 4001], by: "sam" }) }).then(async (r) => expect((await r.json()).error.code).toBe("order_conflict"));
    expect((await http("/v1/queue/order", { method: "PUT", body: JSON.stringify({ prs: [4001, 4003], by: "sam" }) })).status).toBe(200);
    const r = dak("queue", "order", "4003", "4001", "--from", "atlas", "--json").json();
    expect(r.kept.sort()).toEqual([4001, 4003]);
    const rows = dak("queue", "--json").json().filter((x: any) => [4001, 4003].includes(x.pr));
    expect(rows.map((x: any) => [x.pr, x.rank, x.rank_by])).toEqual([[4001, 1, "sam"], [4003, 2, "sam"]]);
    expect(dak("queue", "priority", "4001", "--tier", "later", "--from", "atlas", "--json").json().error.code).toBe("person_ordered");
    // The person approves an order on a thread: the agent applies it as theirs, over their own placing.
    const ask = dak("send", "--to", "sam", "--from", "atlas", "--subject", "New order?", "4003 first", "--option", "Use this order", "--option", "Keep mine", "--json").json().thread.id;
    expect(dak("queue", "order", "4003", "4001", "--from", "atlas", "--confirmed-by", ask, "--json").json().error.code).toBe("not_confirmed");
    await http(`/v1/threads/${ask}/messages`, { method: "POST", body: JSON.stringify({ author: "sam", body: "", choice: "Use this order" }) });
    expect(dak("queue", "order", "4003", "4001", "--from", "mitra", "--confirmed-by", ask, "--json").json().error.code).toBe("not_confirmed"); // not mitra's thread
    const done = dak("queue", "order", "4003", "4001", "--from", "atlas", "--confirmed-by", ask, "--json").json();
    expect(done).toMatchObject({ ordered: [4003, 4001], kept: [] });
    const after = dak("queue", "--json").json().filter((x: any) => [4001, 4003].includes(x.pr));
    expect(after.map((x: any) => [x.pr, x.rank, x.rank_by])).toEqual([[4003, 1, "sam"], [4001, 2, "sam"]]);
  });

  test("review order: urgent first with its reason; a hotfix goes urgent on its own", async () => {
    const a = dak("send", "--to", "sam", "--from", "atlas", "--diff", "d2.diff", "--subject", "Normal one", "--json").json().thread.id;
    const b = dak("send", "--to", "sam", "--from", "atlas", "--diff", "d2.diff", "--subject", "Unblocker", "--json").json().thread.id;
    const h = dak("send", "--to", "sam", "--from", "atlas", "--diff", "d2.diff", "--subject", "Hotfix", "--hotfix", "--json").json().thread.id;
    expect(dak("queue", "priority", b, "--review", "--tier", "urgent", "--why", "unblocks 8 PRs", "--from", "atlas").code).toBe(0);
    dak("queue", "review-order", b, h, "--from", "atlas");
    const list = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    const ids = list.map((r) => r.thread_id).filter((id) => [a, b, h].includes(id));
    expect(ids).toEqual([b, h, a]);
    expect(list.find((r) => r.thread_id === b)).toMatchObject({ tier: "urgent", why: "unblocks 8 PRs" });
    expect(list.find((r) => r.thread_id === h)).toMatchObject({ tier: "urgent", why: "Hotfix" });
  });
});

describe("waking a closed session", () => {
  test("mail for a Claude Code session with no live process starts one background turn on it; a live one is left to its hooks", async () => {
    const { mkdirSync, writeFileSync: wf, chmodSync, existsSync } = await import("node:fs");
    const { tickSleepers, startRun, recentWakes } = await import("../src/sleeper");
    const { touch } = await import("../src/presence");
    const fake = join(home, "fake-claude.sh");
    wf(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(home, "woke.txt")}"\n`);
    chmodSync(fake, 0o755);
    process.env.DAK_CLAUDE_BIN = fake;
    mkdirSync(process.env.DAK_CLAUDE_SESSIONS!, { recursive: true });
    touch("sleepy", { tool: "claude-code", where: repo, session: "sess-sleepy" });
    // A live session: its process file names it and the process is alive (this one).
    touch("awake", { tool: "claude-code", where: repo, session: "sess-awake" });
    wf(join(process.env.DAK_CLAUDE_SESSIONS!, "1.json"), JSON.stringify({ pid: process.pid, sessionId: "sess-awake" }));
    dak("send", "--to", "sleepy", "--from", "atlas", "--subject", "Wake up", "Merged #2438.");
    dak("send", "--to", "awake", "--from", "atlas", "--subject", "Hello", "Hi.");
    const woken: string[] = [];
    // Other tests' closed sessions with mail are woken too; only "sleepy" runs here.
    tickSleepers((agent, sid, where) => { woken.push(agent); if (agent === "sleepy") startRun(agent, sid, where); }, { force: true });
    expect(woken).toContain("sleepy");
    expect(woken).not.toContain("awake");
    for (let i = 0; i < 40 && !existsSync(join(home, "woke.txt")); i++) await Bun.sleep(100);
    const args = readFileSync(join(home, "woke.txt"), "utf8");
    expect(args).toContain("--resume\nsess-sleepy");
    expect(args).toContain("Merged #2438.");
    expect(dak("inbox", "--for", "sleepy", "--unread", "--peek", "--json").json()).toEqual([]); // taken: no hook hands it over again
    expect(dak("inbox", "--for", "awake", "--unread", "--peek", "--json").json().length).toBe(1);
    for (let i = 0; i < 40 && recentWakes(1)[0]?.status === "running"; i++) await Bun.sleep(100);
    expect(recentWakes(1)[0]).toMatchObject({ agent: "sleepy", from_name: "atlas", subject: "Wake up", status: "done" });
    // Nothing new: the next tick starts nothing.
    woken.length = 0;
    tickSleepers((agent) => woken.push(agent), { force: true });
    expect(woken).not.toContain("sleepy");
  });
});

describe("waiting on you, by type", () => {
  test("PRs, briefs and decisions in one order; updates and approved PRs stay out; a question after approval is a decision; blocks show", async () => {
    writeFileSync(join(repo, "d2.diff"), "diff --git a/q.ts b/q.ts\n--- a/q.ts\n+++ b/q.ts\n@@ -1 +1 @@\n-a\n+b\n");
    const send = (...a: string[]) => { const r = dak("send", "--to", "zari", "--from", "atlas", ...a, "--json"); if (r.code) throw new Error(r.out + r.err); return r.json().thread.id; };
    const pr = send("--diff", "d2.diff", "--subject", "A PR", "--option", "Approve", "--option", "Hold"); // buttons on a PR: still a PR
    const brief = send("--subject", "The brief", "--link", "https://example.com/mock", "Read this", "--blocks", "Rohan, #2433");
    const ask = send("--subject", "Which way?", "Pick one", "--option", "A", "--option", "B");
    send("--subject", "FYI", "Tests running", "--fyi");
    const merged = send("--diff", "d2.diff", "--subject", "Approved PR");
    dak("reply", merged, "--from", "zari", "--verdict", "approve", "ok");
    const after = send("--diff", "d2.diff", "--subject", "Approved then asked");
    dak("reply", after, "--from", "zari", "--verdict", "approve", "ok");
    dak("reply", after, "--from", "atlas", "Merge now or after the pair?", "--option", "Now", "--option", "After");
    const typed = send("--subject", "Spec", "Please read", "--type", "brief");
    const list = (await (await http("/v1/reviews?for=zari")).json()) as any[];
    const byId = new Map(list.map((r) => [r.thread_id, r]));
    expect(byId.get(pr).type).toBe("pr");
    expect(byId.get(brief)).toMatchObject({ type: "brief", blocks: "Rohan, #2433" });
    expect(byId.get(ask).type).toBe("decision");
    expect(byId.get(after).type).toBe("decision");
    expect(byId.get(typed).type).toBe("brief");
    expect(byId.has(merged)).toBe(false);
    expect(list.some((r) => r.subject === "FYI")).toBe(false);
    expect(dak("send", "--to", "zari", "--from", "atlas", "--subject", "x", "y", "--type", "doc", "--json").json().error.code).toBe("bad_type");
  });
});

describe("the phone", () => {
  test("only the phone's key gets in through its tunnel; it cannot change the Mac's setup; signing out locks the old key out", async () => {
    const { writeFileSync: wf } = await import("node:fs");
    // A stand-in tunnel: a live process and a log that names the address.
    const fakeTunnel = Bun.spawn(["sleep", "60"]);
    wf(join(home, "phone.json"), JSON.stringify({ pid: fakeTunnel.pid, url: "https://test-phone.trycloudflare.com", started_at: "now" }));
    wf(join(home, "phone-tunnel.log"), "https://test-phone.trycloudflare.com\nRegistered tunnel connection");
    const { phoneKey } = await import("../src/phone");
    const key = phoneKey();
    const via = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, redirect: "manual",
      headers: { host: "test-phone.trycloudflare.com", "cf-ray": "x", ...(init.headers ?? {}) } });
    expect((await via("/")).status).toBe(401);
    expect((await via(`/v1/queue`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401); // the Mac's token is not the phone's
    expect((await via("/m?k=wrong")).status).toBe(401);
    const signin = await via(`/m?k=${key}`);
    expect(signin.status).toBe(303);
    const cookie = signin.headers.get("set-cookie")!.split(";")[0];
    expect(signin.headers.get("set-cookie")).toContain("HttpOnly");
    const page = await (await via("/", { headers: { cookie } })).text();
    expect(page).toContain('"phone":true');
    expect(page).not.toContain(token);
    expect((await via("/v1/queue", { headers: { cookie } })).status).toBe(200);
    expect((await via("/v1/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await via("/v1/phone", { method: "POST", headers: { cookie } })).status).toBe(403);
    // Another tunnel's host gets nothing.
    expect((await fetch(base + "/", { headers: { host: "other.trycloudflare.com", "cf-ray": "x", cookie } })).status).toBe(403);
    // Sign out on the Mac: a new key, the tunnel closed, the old cookie refused.
    expect((await http("/v1/phone?signout=1", { method: "DELETE" })).status).toBe(200);
    await fakeTunnel.exited;
    expect((await via("/v1/queue", { headers: { cookie } })).status).toBe(403);
    expect(phoneKey()).not.toBe(key);
  });
});

describe("PRs", () => {
  test("chapters check names the hunk that is in no chapter", () => {
    writeFileSync(join(repo, "ch.json"), JSON.stringify([{ title: "Return ten", summary: "", risk: "low", hunks: [{ file: "taps.ts", start: 1 }] }]));
    const r = dak("chapters", "check", "ch.json", "--base", "main", "--json");
    expect(r.code).toBe(1);
    expect(r.json().problems).toEqual(["service.ts hunk at line 1 is in no chapter."]);
  });

  test("a bad key-change line is refused at send time", () => {
    writeFileSync(join(repo, "bad.json"), JSON.stringify([{ title: "All", risk: "low",
      hunks: [{ file: "taps.ts", start: 1 }, { file: "service.ts", start: 1 }],
      key_changes: [{ text: "Nowhere", file: "taps.ts", line: 99 }] }]));
    const r = dak("send", "--to", "sam", "--from", "atlas", "--base", "main", "--chapters", "bad.json", "--json");
    expect(r.code).toBe(1);
    expect(r.json().error.message).toContain("taps.ts new line 99, which is not in the diff");
  });

  test("chapters draft lists every hunk by folder; check refuses its placeholders until they are written", () => {
    const d = dak("chapters", "draft", "--base", "main");
    expect(d.code).toBe(0);
    const draft = JSON.parse(d.out);
    const chapters = Array.isArray(draft) ? draft : draft.chapters;
    expect(chapters.flatMap((c: any) => c.hunks).map((h: any) => h.file).sort()).toEqual(["service.ts", "taps.ts"]);
    writeFileSync(join(repo, "draft.json"), d.out);
    const r = dak("chapters", "check", "draft.json", "--base", "main", "--json");
    expect(r.code).toBe(1);
    expect(r.json().problems.join(" ")).toContain("placeholder");
  });

  test("a concept chapter has no hunks of its own, only key changes inside another chapter's hunk", () => {
    writeFileSync(join(repo, "concept.json"), JSON.stringify([
      { title: "All", summary: "Both files.", risk: "low", hunks: [{ file: "taps.ts", start: 1 }, { file: "service.ts", start: 1 }] },
      { title: "The new limit", summary: "Why ten.", risk: "low", key_changes: [{ text: "Ten", file: "taps.ts", line: 2 }] }]));
    expect(dak("chapters", "check", "concept.json", "--base", "main").code).toBe(0);
    writeFileSync(join(repo, "empty.json"), JSON.stringify([
      { title: "All", summary: "", risk: "low", hunks: [{ file: "taps.ts", start: 1 }, { file: "service.ts", start: 1 }] },
      { title: "Nothing", summary: "", risk: "low", hunks: [] }]));
    const r = dak("chapters", "check", "empty.json", "--base", "main", "--json");
    expect(r.json().problems.join(" ")).toContain("no hunks and no key_changes");
  });

  test("--message-file keeps $ and backticks as written", () => {
    writeFileSync(join(repo, "msg.txt"), "Costs $5 and `$HOME` stays.\n");
    const r = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Dollars", "--message-file", "msg.txt", "--json");
    expect(r.json().message.body).toBe("Costs $5 and `$HOME` stays.\n");
  });

  test("show says whether the reader has opened the thread, and when", () => {
    const id = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Seen?", "hello", "--json").json().thread.id;
    expect(dak("show", id).out).toContain("sam has not opened it");
    expect(dak("show", id, "--json").json().reads.find((r: any) => r.reader === "sam")).toBeUndefined();
    dak("inbox", "--for", "sam", "--unread");
    const mark = dak("show", id, "--json").json().reads.find((r: any) => r.reader === "sam");
    expect(mark.seen_at).toBeTruthy();
    expect(dak("show", id).out).toContain("sam read it all");
  });

  test("refresh moves a thread's PR to the new head in place, with no new message", () => {
    const sent = dak("send", "--to", "sam", "--from", "atlas", "--base", "main", "--subject", "Moving", "--json").json();
    const before = sent.message.attachments[0].meta.head_sha;
    writeFileSync(join(repo, "extra.ts"), "export const x = 1;\n");
    git("add", "extra.ts"); git("commit", "-qm", "more");
    const r = dak("refresh", sent.thread.id, "--json");
    expect(r.code).toBe(0);
    const t = dak("show", sent.thread.id, "--json").json();
    expect(t.messages.length).toBe(1);
    const meta = t.messages[0].attachments[0].meta;
    expect(meta.head_sha).not.toBe(before);
    expect(meta.files.map((f: any) => f.path)).toContain("extra.ts");
    git("reset", "-q", "--hard", "HEAD~1");
  });

  test("a ready-for-review handoff needs its proofs and the current head", () => {
    const send = (...extra: string[]) => dak("send", "--to", "sam", "--from", "atlas", "--base", "main", "--subject", "Ready", "--ready", ...extra, "--json").json();
    const missing = send();
    expect(missing.error.code).toBe("handoff_incomplete");
    expect(missing.error.message).toContain("--migration");
    expect(send("--migration", "none", "--proof", "tests:maybe").error.code).toBe("bad_proof");
    expect(send("--migration", "none", "--proof", "tests:pass:12", "--head", "0000000").error.code).toBe("stale_head");
    const head = git("rev-parse", "HEAD").trim();
    const ok = send("--migration", "none", "--proof", "tests:pass:12", "--proof", "build:pass", "--skipped", "e2e: no device", "--head", head.slice(0, 8));
    expect(ok.message.handoff).toMatchObject({ head, base: "main", migration: "none",
      proofs: [{ name: "tests", result: "pass", count: 12 }, { name: "build", result: "pass" }], skipped: [{ name: "e2e", reason: "no device" }] });
    expect(dak("show", ok.thread.id).out).toContain("Ready for review at");
  });

  test("reply --head-only moves the head in place and leaves a note that asks nothing", () => {
    const sent = dak("send", "--to", "sam", "--from", "atlas", "--base", "main", "--subject", "Renumber", "--json").json();
    writeFileSync(join(repo, "extra2.ts"), "export const y = 2;\n");
    git("add", "extra2.ts"); git("commit", "-qm", "renumber");
    expect(dak("reply", sent.thread.id, "--from", "atlas", "--head-only", "Renumbered, same SQL").code).toBe(0);
    const t = dak("show", sent.thread.id, "--json").json();
    expect(t.messages.length).toBe(2);
    expect(t.messages[1].attachments.length).toBe(0);
    expect(t.messages[0].attachments[0].meta.head_sha).toBe(git("rev-parse", "HEAD").trim());
    git("reset", "-q", "--hard", "HEAD~1");
  });

  test("a reviewer runner reviews a PR sent to it and posts anchored findings and chapter notes", async () => {
    const review = JSON.stringify({ summary: "One real risk.", verdict: "changes",
      findings: [{ file: "taps.ts", line: 2, side: "new", severity: "high", body: "Callers still expect 1." }, { file: "nowhere.ts", line: 9, severity: "medium", body: "Off the diff." }],
      reviewer_notes: [{ chapter: 1, text: "Read every caller." }] });
    const fake = JSON.stringify(["sh", "-c", `echo 'thinking...'; echo '${review}'`]);
    expect(dak("runner", "add", "rev", "--command", fake).code).toBe(0);
    writeFileSync(join(repo, "two.json"), JSON.stringify([{ title: "All", summary: "", risk: "low", hunks: [{ file: "taps.ts", start: 1 }, { file: "service.ts", start: 1 }] }]));
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--cc", "rev:reviewer", "--base", "main", "--chapters", "two.json", "--subject", "Review me", "--json").json();
    const got = dak("wait", thread.id, "--for", "atlas", "--timeout", "15s", "--json").json();
    const m = got.messages[0];
    expect(m.author).toBe("rev");
    expect(m.verdict).toBe("changes");
    expect(m.comments).toEqual([expect.objectContaining({ anchor: { kind: "code", file: "taps.ts", side: "new", start_line: 2, end_line: 2 }, body: "**High.** Callers still expect 1." })]);
    expect(m.body).toContain("nowhere.ts:9");
    const meta = dak("show", thread.id, "--json").json().messages[0].attachments[0].meta;
    expect(meta.chapters[0].reviewer_note).toEqual({ by: "rev", text: "Read every caller." });
    dak("runner", "remove", "rev");
  });

  test("a PR is snapshotted, so the whole file still opens after the branch is gone", async () => {
    writeFileSync(join(repo, "ok.json"), JSON.stringify([
      { title: "Return ten", summary: "a() now returns 10.", risk: "medium", risk_why: "Callers expect 1.", hunks: [{ file: "taps.ts", start: 1 }],
        why: "Ten is the new limit.", check: ["Does any caller still assume 1?", "  "], proof: "taps.test.ts covers both", noticed: "Nothing visible.",
        reviewer_note: { by: "cursor", text: "Read every caller; none assume 1." },
        key_changes: [{ text: "New value", file: "taps.ts", line: 2 }, { text: "Old value", file: "taps.ts", side: "old", line: 2 }] },
      { title: "Add the service", summary: "", risk: "low", hunks: [{ file: "service.ts", start: 1 }] }]));
    const r = dak("send", "--to", "sam", "--from", "atlas", "--base", "main", "--chapters", "ok.json", "--subject", "Return ten", "--json");
    expect(r.code).toBe(0);
    const pr = r.json().message.attachments[0];
    expect(pr.type).toBe("pr");
    expect(pr.meta.files.map((f: any) => [f.path, f.status, f.additions, f.deletions])).toEqual([["service.ts", "added", 2, 0], ["taps.ts", "modified", 1, 1]]);
    expect(pr.meta.chapters[0].risk_why).toBe("Callers expect 1.");
    expect(pr.meta.chapters[0]).toMatchObject({ why: "Ten is the new limit.", check: ["Does any caller still assume 1?"], proof: "taps.test.ts covers both",
      noticed: "Nothing visible.", reviewer_note: { by: "cursor", text: "Read every caller; none assume 1." } });

    git("checkout", "-q", "main"); git("branch", "-qD", "feature");
    const taps = pr.meta.files.find((f: any) => f.path === "taps.ts");
    const blob = await fetch(`${base}/v1/blobs/${taps.new_blob}`, { headers: { authorization: `Bearer ${token}` } });
    expect(await blob.text()).toContain("return 10;");
  });
});

describe("the HTTP door", () => {
  test("no token, a foreign Host and a foreign Origin are all refused", async () => {
    expect((await fetch(`${base}/v1/me`)).status).toBe(401);
    expect((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}`, host: "evil.example:80" } })).status).toBe(403);
    expect((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } })).status).toBe(403);
    expect((await http("/v1/me")).status).toBe(200);
  });

  test("errors come back in one shape with a stable code", async () => {
    const r = await http("/v1/threads/t_missing");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: "no_thread", message: "No thread t_missing." } });
  });

  test("the page carries the token for its own scripts", async () => {
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain(`"token":"${token}"`);
    expect(page).toContain('"me":"sam"');
  });

  test("an agent can send a doc over HTTP and long-poll for the answer", async () => {
    const created = await (await http("/v1/threads", { method: "POST", body: JSON.stringify({
      to: "sam", from: "cursor", subject: "Over HTTP", body: "hi", attachments: [{ type: "doc", name: "x.md", content: "# X" }] }) })).json();
    const poll = http(`/v1/threads/${created.thread.id}/wait?for=cursor&timeout=10`);
    await Bun.sleep(300);
    await http(`/v1/threads/${created.thread.id}/messages`, { method: "POST", body: JSON.stringify({ author: "sam", body: "ok", verdict: "approve" }) });
    const got = await (await poll).json();
    expect(got.messages[0].verdict).toBe("approve");
  });
});

describe("explain", () => {
  test("runs the configured helper with the selection and returns its answer without posting anything", async () => {
    const list = await (await http("/v1/threads?for=sam&box=to")).json();
    const t = list.find((x: any) => x.subject === "Return ten");
    const full = await (await http(`/v1/threads/${t.id}`)).json();
    const pr = full.messages[0].attachments[0];
    const before = full.messages.length;
    const r = await http("/v1/explain", { method: "POST", body: JSON.stringify({ thread_id: t.id, attachment_id: pr.id, file: "taps.ts", side: "new", start_line: 2, end_line: 2 }) });
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.answer).toBe("EXPLAINED\n1");
    expect((await (await http(`/v1/threads/${t.id}`)).json()).messages.length).toBe(before);
  });
});

describe("push to Claude Code sessions", () => {
  const hook = (input: object) => {
    const p = Bun.spawnSync(["bun", CLI, "hook", "claude-code"], { env: { ...process.env, DAK_HOME: home }, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe" });
    return p.stdout.toString();
  };
  const cwd = "/tmp/work/eng-2857-register-brief-67dfca";

  test("a session that ran the hook can be written to, and gets the message at its next turn", () => {
    expect(hook({ hook_event_name: "SessionStart", cwd, session_id: "s1" })).toBe("");
    const sent = dak("send", "--to", "eng-2857-register-brief-67dfca", "--from", "sam", "--subject", "Status?", "Where are you on the brief?", "--json");
    expect(sent.code).toBe(0);
    const text = hook({ hook_event_name: "UserPromptSubmit", cwd, session_id: "s1" });
    expect(text).toContain("Where are you on the brief?");
    expect(text).toContain("dak reply " + sent.json().thread.id);
    expect(hook({ hook_event_name: "UserPromptSubmit", cwd, session_id: "s1" })).toBe("");
  });

  test("a message that lands mid-turn blocks the stop so the agent reads it and carries on", () => {
    dak("send", "--to", "eng-2857-register-brief-67dfca", "--from", "sam", "--subject", "One more", "Also add the mock link.");
    const out = JSON.parse(hook({ hook_event_name: "Stop", cwd, stop_hook_active: false }));
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("Also add the mock link.");
    expect(hook({ hook_event_name: "Stop", cwd, stop_hook_active: true })).toBe("");
  });

  test("a broken hook input prints nothing and exits 0", () => {
    const p = Bun.spawnSync(["bun", CLI, "hook", "claude-code"], { env: { ...process.env, DAK_HOME: home }, stdin: new TextEncoder().encode("not json"), stdout: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toBe("");
  });

  test("agents lists readers and seen sessions, with who is listening", () => {
    const list = dak("agents", "--json").json();
    const s = list.find((a: any) => a.name === "eng-2857-register-brief-67dfca");
    expect(s).toMatchObject({ tool: "claude-code", reader: false, listening: true, where: cwd });
    expect(list[0]).toMatchObject({ name: "sam", kind: "person" });
  });
});

describe("settings, connecting Claude Code, and GitHub reviews", () => {
  test("the helper can be switched, and a reader can be given a role and a session", async () => {
    let r = await (await http("/v1/settings", { method: "PUT", body: JSON.stringify({ helper: "codex" }) })).json();
    expect(r.helper).toBe("codex");
    expect(r.command[0]).toBe("codex");
    r = await (await http("/v1/settings", { method: "PUT", body: JSON.stringify({ reader: { name: "atlas", about: "Coordinates the engineers", where: "/tmp/work/atlas-2-8e9e62" } }) })).json();
    expect(r.readers.find((x: any) => x.name === "atlas")).toMatchObject({ about: "Coordinates the engineers", where: "/tmp/work/atlas-2-8e9e62" });
    // A session in Atlas's folder now receives Atlas's mail.
    const { thread } = dak("send", "--to", "atlas", "--from", "sam", "--subject", "Ping", "Are you there?", "--json").json();
    const p = Bun.spawnSync(["bun", CLI, "hook", "claude-code"], { env: { ...process.env, DAK_HOME: home }, stdin: new TextEncoder().encode(JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: "/tmp/work/atlas-2-8e9e62" })), stdout: "pipe" });
    expect(p.stdout.toString()).toContain(`dak reply ${thread.id} --from atlas`);
    r = await (await http("/v1/settings", { method: "PUT", body: JSON.stringify({ model: { helper: "claude", value: "sonnet" } }) })).json();
    expect(r.models).toEqual({ claude: "sonnet" });
    expect((await http("/v1/settings", { method: "PUT", body: JSON.stringify({ model: { helper: "claude", value: "rm -rf" } }) })).status).toBe(400);
    await http("/v1/settings", { method: "PUT", body: JSON.stringify({ helper: "custom", command: ["sh", "-c", "echo EXPLAINED; echo \"$0\" | grep -c 'Selected:'"] }) });
  });

  test("connecting Claude Code adds only Dak's hooks, keeps a copy, and disconnecting removes only them", async () => {
    const settings = join(home, "claude-settings.json");
    process.env.DAK_CLAUDE_SETTINGS = settings;
    writeFileSync(settings, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    const on = await (await http("/v1/connect/claude", { method: "POST" })).json();
    expect(on.claude_connected).toBe(true);
    const s = JSON.parse(readFileSync(settings, "utf8"));
    expect(s.model).toBe("opus");
    expect(s.hooks.Stop.map((e: any) => e.hooks[0].command)).toEqual(["say done", "dak hook claude-code", join(home, "wake.sh")]);
    expect(s.hooks.Stop[2].hooks[0]).toMatchObject({ asyncRewake: true, timeout: 43200 });
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(JSON.parse(readFileSync(settings + ".before-dak", "utf8")).hooks.Stop).toHaveLength(1);
    const off = await (await http("/v1/connect/claude", { method: "DELETE" })).json();
    expect(off.claude_connected).toBe(false);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
  });

  test("connecting Codex writes its own hooks file the same way", async () => {
    const hooks = join(home, "codex-hooks.json");
    process.env.DAK_CODEX_HOOKS = hooks;
    const on = await (await http("/v1/connect/codex", { method: "POST" })).json();
    expect(on.codex_connected).toBe(true);
    expect(JSON.parse(readFileSync(hooks, "utf8")).hooks.Stop[0].hooks[0].command).toBe("dak hook codex");
    expect((await (await http("/v1/connect/codex", { method: "DELETE" })).json()).codex_connected).toBe(false);
  });

  test("a GitHub review carries the verdict and line comments, and skips doc comments", () => {
    const { reviewPayload, prCoordinates } = require("../src/github");
    const meta = { url: "https://github.com/acme/app/pull/12", head_sha: "abc" } as any;
    expect(prCoordinates(meta)).toEqual({ owner: "acme", repo: "app", number: 12 });
    const p = reviewPayload(meta, "Close.", "changes", [
      { anchor: { kind: "code", file: "a.ts", side: "new", start_line: 4, end_line: 6 }, body: "why?" },
      { anchor: { kind: "code", file: "b.ts", side: "old", start_line: 9, end_line: 9 }, body: "gone?" },
      { anchor: { kind: "doc", version: 1, block_index: 0, block_hash: "x", quote: "q" }, body: "doc note" }]);
    expect(p).toEqual({ commit_id: "abc", body: "Close.", event: "REQUEST_CHANGES", comments: [
      { path: "a.ts", line: 6, side: "RIGHT", start_line: 4, start_side: "RIGHT", body: "why?" },
      { path: "b.ts", line: 9, side: "LEFT", body: "gone?" }] });
  });

  test("a medium-risk chapter with no reason is refused", () => {
    writeFileSync(join(repo, "noreason.json"), JSON.stringify([{ title: "Risky", risk: "medium", hunks: [{ file: "taps.ts", start: 1 }, { file: "service.ts", start: 1 }] }]));
    git("checkout", "-qb", "again"); writeFileSync(join(repo, "x.ts"), "export const x = 1;\n"); git("add", "."); git("commit", "-qm", "x");
    const r = dak("chapters", "check", "noreason.json", "--base", "main", "--json");
    expect(r.json().problems.join(" ")).toContain("is medium risk but has no risk_why");
  });

  test("a high-risk chapter with no proof is refused", () => {
    writeFileSync(join(repo, "noproof.json"), JSON.stringify([{ title: "Risky", risk: "high", risk_why: "Money moves.", hunks: [{ file: "taps.ts", start: 1 }, { file: "service.ts", start: 1 }] }]));
    const r = dak("chapters", "check", "noproof.json", "--base", "main", "--json");
    expect(r.json().problems.join(" ")).toContain("is high risk but has no proof");
  });
});

describe("the outside door for remote agents", () => {
  test("an agent key opens only its own routes, from any host, and only as that agent", async () => {
    const { agentKey } = await import("../src/tunnel");
    const key = agentKey("grok");
    const out = (path: string, init: RequestInit = {}, k = key) =>
      fetch(base + path, { ...init, headers: { authorization: `Bearer ${k}`, host: "abc.trycloudflare.com", "content-type": "application/json" } });
    // The master token does not open the outside door, and an agent key does not open the inside one.
    expect((await out("/x/inbox", {}, token)).status).toBe(401);
    expect((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    expect((await fetch(`${base}/v1/me`, { headers: { authorization: `Bearer ${token}`, host: "abc.trycloudflare.com" } })).status).toBe(403);
    const sent = await (await out("/x/send", { method: "POST", body: JSON.stringify({ subject: "Reel 3 hooks", body: "Which first line?" }) })).json();
    expect(sent.thread).toMatchObject({ from: "grok", to: "sam" });
    // Grok cannot read a thread that is not its own.
    const other = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Private", "not for grok", "--json").json();
    expect((await out(`/x/wait/${other.thread.id}?timeout=1`)).status).toBe(404);
    await http(`/v1/threads/${sent.thread.id}/messages`, { method: "POST", body: JSON.stringify({ author: "sam", body: "The second one." }) });
    const got = await (await out(`/x/wait/${sent.thread.id}?timeout=5`)).json();
    expect(got.messages[0].body).toBe("The second one.");
    // It can read its own instructions, without its key in them.
    const skill = await (await out("/x/skill")).text();
    expect(skill).toContain("/x/send");
    expect(skill).not.toContain(key);
    // It can say what kind of ask it is, what it blocks, and how urgent: the same as the CLI.
    const ask = await (await out("/x/send", { method: "POST", body: JSON.stringify({ subject: "Launch post", body: "Read the draft", type: "brief", blocks: "Zari's Friday post", tier: "urgent", why: "goes out Friday" }) })).json();
    const row = ((await (await http("/v1/reviews?for=sam")).json()) as any[]).find((r) => r.thread_id === ask.thread.id);
    expect(row).toMatchObject({ type: "brief", blocks: "Zari's Friday post", tier: "urgent", why: "goes out Friday" });
    expect((await out(`/x/priority/${ask.thread.id}`, { method: "PUT", body: JSON.stringify({ tier: "later" }) })).status).toBe(200);
    expect((await out(`/x/priority/${other.thread.id}`, { method: "PUT", body: JSON.stringify({ tier: "later" }) })).status).toBe(404); // not its own
    // One key, several bots: each sends under its own name; replies to any of them come back on the key.
    const orbit = await (await out("/x/send", { method: "POST", body: JSON.stringify({ from: "Orbit", subject: "Ops", body: "Status?" }) })).json();
    expect(orbit.thread).toMatchObject({ from: "orbit", to: "sam" });
    expect((await out("/x/send", { method: "POST", body: JSON.stringify({ from: "atlas", body: "x" }) })).status).toBe(403); // a reader's name is not free
    await http(`/v1/threads/${orbit.thread.id}/messages`, { method: "POST", body: JSON.stringify({ author: "sam", body: "All good." }) });
    expect(((await (await out("/x/inbox")).json()) as any[]).some((m) => m.thread_id === orbit.thread.id && m.body === "All good.")).toBe(true);
    const r2 = await (await out(`/x/reply/${orbit.thread.id}`, { method: "POST", body: JSON.stringify({ body: "Thanks" }) })).json();
    expect(r2.author).toBe("orbit"); // the reply goes out as the bot on the thread
    // It can write to another agent directly, and the agent's answer reaches its inbox.
    const names = ((await (await out("/x/agents")).json()) as any[]).map((a) => a.name);
    expect(names).toContain("zari");
    expect(names).not.toContain("grok");
    const toZari = await (await out("/x/send", { method: "POST", body: JSON.stringify({ to: "zari", subject: "Hooks", body: "Draft three?" }) })).json();
    expect(toZari.thread).toMatchObject({ from: "grok", to: "zari" });
    dak("reply", toZari.thread.id, "--from", "zari", "Drafting now.");
    expect(((await (await out("/x/inbox")).json()) as any[]).some((m) => m.body === "Drafting now.")).toBe(true);
  });

  test("connecting Cursor adds flat entries to its own hooks file, and its stop hook carries mail", async () => {
    const hooks = join(home, "cursor-hooks.json");
    process.env.DAK_CURSOR_HOOKS = hooks;
    writeFileSync(hooks, JSON.stringify({ version: 1, hooks: { stop: [{ command: "orca stop" }] } }));
    expect((await (await http("/v1/connect/cursor", { method: "POST" })).json()).cursor_connected).toBe(true);
    expect(JSON.parse(readFileSync(hooks, "utf8")).hooks.stop.map((e: any) => e.command)).toEqual(["orca stop", "dak hook cursor"]);
    dak("send", "--to", "sam", "--from", "cursorbot", "--subject", "hi", "x");
    dak("send", "--to", "cursorbot", "--from", "sam", "--subject", "For Cursor", "Please rename the helper.");
    const run = (input: object) => Bun.spawnSync(["bun", CLI, "hook", "cursor"], { env: { ...process.env, DAK_HOME: home, DAK_NAME: "cursorbot" }, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe" }).stdout.toString();
    expect(JSON.parse(run({ hook_event_name: "beforeSubmitPrompt", workspace_roots: ["/tmp/w"] }))).toEqual({ continue: true });
    expect(JSON.parse(run({ hook_event_name: "stop", workspace_roots: ["/tmp/w"] })).followup_message).toContain("Please rename the helper.");
    expect((await (await http("/v1/connect/cursor", { method: "DELETE" })).json()).cursor_connected).toBe(false);
    expect(JSON.parse(readFileSync(hooks, "utf8")).hooks.stop.map((e: any) => e.command)).toEqual(["orca stop"]);
  });
});

describe("diff parser", () => {
  test("reads renames, deletions and hunk counts", () => {
    const files = parseDiff([
      "diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts",
      "--- a/old.ts", "+++ b/new.ts", "@@ -1,2 +1,2 @@", " keep", "-gone", "+came", "",
      "diff --git a/dead.ts b/dead.ts", "deleted file mode 100644", "--- a/dead.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", ""].join("\n"));
    expect(files.map((f) => [f.path, f.old_path, f.status, f.additions, f.deletions])).toEqual([["new.ts", "old.ts", "renamed", 1, 1], ["dead.ts", null, "deleted", 0, 1]]);
    expect(files[0].hunks[0].lines).toEqual([" keep", "-gone", "+came"]);
  });
});

describe("coordination: holds, routes, confirmations, moved heads, try-it", () => {
  const post = (id: string, body: object) => http(`/v1/threads/${id}/messages`, { method: "POST", body: JSON.stringify(body) });
  beforeAll(() => {
    writeFileSync(join(repo, "h1.diff"), "diff --git a/h.ts b/h.ts\n--- a/h.ts\n+++ b/h.ts\n@@ -1 +1 @@\n-one\n+uno\n");
    // The same change after a rebase: the hunk moved and its context changed, the lines did not.
    writeFileSync(join(repo, "h2.diff"), "diff --git a/h.ts b/h.ts\nindex 1111111..2222222 100644\n--- a/h.ts\n+++ b/h.ts\n@@ -7,2 +7,2 @@\n context moved\n-one\n+uno\n");
    writeFileSync(join(repo, "h3.diff"), "diff --git a/h.ts b/h.ts\n--- a/h.ts\n+++ b/h.ts\n@@ -1 +1 @@\n-one\n+eins\n");
  });

  test("send --json gives thread_id; thread --pr names a missing PR plainly", () => {
    const r = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Ids", "hello", "--json").json();
    expect(r.thread_id).toBe(r.thread.id);
    expect(dak("thread", "--pr", "999999", "--json").json().error.code).toBe("no_thread");
  });

  test("--rework greys a review out below the rest until its next version; parked stays out of the count until unparked", async () => {
    const a = dak("send", "--to", "sam", "--from", "atlas", "--diff", "h1.diff", "--subject", "About to change", "--json").json().thread_id;
    const b = dak("send", "--to", "sam", "--from", "atlas", "--diff", "h1.diff", "--subject", "Still fine", "--json").json().thread_id;
    expect(dak("queue", "set", a, "--rework", "prefix being added", "--from", "atlas").code).toBe(0);
    let list = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    const ia = list.findIndex((r) => r.thread_id === a), ib = list.findIndex((r) => r.thread_id === b);
    expect(list[ia].hold).toMatchObject({ kind: "rework", note: "prefix being added", by: "atlas" });
    expect(ia).toBeGreaterThan(ib);
    expect(dak("queue").out).toContain("Not to review now (");
    expect(dak("queue", "--json").json().some((r: any) => r.thread_id === a)).toBe(false); // a review hold adds no queue row
    dak("reply", a, "--from", "atlas", "--diff", "h3.diff", "New version.");
    list = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    expect(list.find((r) => r.thread_id === a).hold).toBeNull(); // back by itself
    dak("queue", "set", b, "--state", "parked", "--waiting", "department settings", "--from", "atlas");
    list = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    expect(list.find((r) => r.thread_id === b).hold).toMatchObject({ kind: "parked", note: "department settings" });
    dak("reply", b, "--from", "atlas", "--diff", "h3.diff", "Another version."); // parked is the person's call: a version does not lift it
    expect(((await (await http("/v1/reviews?for=sam")).json()) as any[]).find((r) => r.thread_id === b).hold?.kind).toBe("parked");
    dak("queue", "unpark", b, "--from", "atlas");
    expect(((await (await http("/v1/reviews?for=sam")).json()) as any[]).find((r) => r.thread_id === b).hold).toBeNull();
  });

  test("a queue row being reworked is skipped by next; a parked row is its own state", () => {
    const t = dak("send", "--to", "sam", "--from", "atlas", "--diff", "h1.diff", "--subject", "Queued then reworked", "--json").json().thread_id;
    dak("queue", "set", "6001", "--state", "approved", "--thread", t, "--tier", "urgent", "--title", "R6001");
    expect(dak("queue", "next", "--json").json().next?.map((r: any) => r.pr)).toContain(6001);
    dak("queue", "set", "6001", "--rework", "department step removed");
    expect(dak("queue", "next", "--json").json().next?.map((r: any) => r.pr) ?? []).not.toContain(6001);
    expect(dak("queue", "--json").json().find((r: any) => r.pr === 6001).hold.kind).toBe("rework");
    dak("queue", "set", "6001", "--rework", "none");
    dak("queue", "set", "6001", "--state", "parked", "--waiting", "his call");
    expect(dak("queue", "--json").json().find((r: any) => r.pr === 6001)).toMatchObject({ state: "parked", hold: { kind: "parked", note: "his call" } });
    dak("queue", "unpark", "6001");
    expect(dak("queue", "--json").json().find((r: any) => r.pr === 6001)).toMatchObject({ state: "approved", hold: null });
  });

  test("--confirmed-by works on priority, and accepts what the person wrote, quoting it", async () => {
    const pr = dak("send", "--to", "sam", "--from", "atlas", "--diff", "h1.diff", "--subject", "Low one", "--json").json().thread_id;
    await http("/v1/reviews/order", { method: "PUT", body: JSON.stringify({ threads: [pr], by: "sam" }) });
    dak("queue", "priority", pr, "--review", "--tier", "urgent", "--from", "sam");
    expect(dak("queue", "priority", pr, "--review", "--tier", "later", "--from", "atlas", "--json").json().error.code).toBe("person_ordered");
    const ask = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Lower?", "Should I move it lower?", "--json").json().thread_id;
    expect(dak("queue", "priority", pr, "--review", "--tier", "later", "--from", "atlas", "--confirmed-by", ask, "--json").json().error.code).toBe("not_confirmed");
    await post(ask, { author: "sam", body: "can you move them lower?" });
    const r = dak("queue", "priority", pr, "--review", "--tier", "later", "--from", "atlas", "--confirmed-by", ask, "--json").json();
    expect(r.confirmed_by).toContain('"can you move them lower?"');
    const row = ((await (await http("/v1/reviews?for=sam")).json()) as any[]).find((x) => x.thread_id === pr);
    expect(row).toMatchObject({ tier: "later", rank_by: "sam" });
  });

  test("a route sends a group's PRs and briefs to someone else first; notes still reach the person", () => {
    dak("group", "set", "engineers", "mitra", "zari");
    expect(dak("route", "set", "sam", "--from-group", "nobody", "--via", "atlas", "--json").json().error.code).toBe("unknown_group");
    expect(dak("route", "set", "sam", "--from-group", "engineers", "--via", "atlas").code).toBe(0);
    const r = dak("send", "--to", "sam", "--from", "mitra", "--diff", "h1.diff", "--subject", "Routed PR", "--json").json();
    expect(r.thread.to).toBe("atlas");
    expect(r.routed).toEqual({ to: "sam", via: "atlas", from_group: "engineers" });
    expect(r.message.body).toContain("sam's rule sends engineers's PRs and briefs to atlas first");
    expect(dak("send", "--to", "sam", "--from", "mitra", "--subject", "A note", "fyi", "--json").json().thread.to).toBe("sam");
    expect(dak("send", "--to", "sam", "--from", "atlas", "--diff", "h1.diff", "--subject", "From atlas", "--json").json().thread.to).toBe("sam");
    dak("route", "remove", "sam", "--from-group", "engineers");
    expect(dak("send", "--to", "sam", "--from", "mitra", "--diff", "h1.diff", "--subject", "Direct", "--json").json().thread.to).toBe("sam");
  });

  test("the queue says when a head moved after the approval, and whether the change is the same", async () => {
    const t = dak("send", "--to", "sam", "--from", "atlas", "--diff", "h1.diff", "--subject", "Moving head", "--json").json().thread_id;
    dak("queue", "set", "6101", "--state", "approved", "--thread", t, "--title", "M6101");
    await post(t, { author: "sam", body: "", verdict: "approve" });
    expect(dak("queue", "--json").json().find((r: any) => r.pr === 6101).head_moved).toBeNull();
    git("commit", "-q", "--allow-empty", "-m", "rebase stand-in");
    dak("refresh", t, "--diff", "h2.diff");
    let row = dak("queue", "--json").json().find((r: any) => r.pr === 6101);
    expect(row.head_moved.change).toBe("rebase only");
    git("commit", "-q", "--allow-empty", "-m", "another");
    dak("refresh", t, "--diff", "h3.diff");
    row = dak("queue", "--json").json().find((r: any) => r.pr === 6101);
    expect(row.head_moved.change).toBe("content changed");
    // A head the script reports that git cannot compare here: moved, change unknown.
    row = dak("queue", "set", "6101", "--head", "deadbeefcafe", "--json").json();
    expect(row.head_moved).toMatchObject({ to: "deadbeefcafe", change: null });
  });

  test("a try-it note: Works carries the ticket back, so the agent posts its proof and moves it to Done", async () => {
    const t = dak("send", "--to", "sam", "--from", "atlas", "--type", "tryit", "--ticket", "REVA-1", "--subject", "Try it: retention", "Open Settings, then Messages.", "--json").json();
    expect(t.message.options).toEqual(["Works: move REVA-1 to Done", "Something's wrong"]);
    expect(((await (await http("/v1/reviews?for=sam")).json()) as any[]).find((r) => r.thread_id === t.thread_id).type).toBe("tryit");
    await post(t.thread_id, { author: "sam", body: "", choice: "Works: move REVA-1 to Done" });
    const got = dak("wait", t.thread_id, "--for", "atlas", "--timeout", "2s", "--json").json();
    expect(got.messages[0].tryit_result).toEqual({ result: "works", ticket: "REVA-1" });
  });

  test("--range must be a range; a read-only store makes the inbox check say so quietly", () => {
    const t = dak("send", "--to", "sam", "--from", "atlas", "--diff", "h1.diff", "--subject", "Stacked", "--json").json().thread_id;
    expect(dak("add", t, "mitra:reviewer", "--range", "not a range", "--json").json().error.code).toBe("bad_range");
    expect(dak("add", t, "mitra:reviewer", "--range", "origin/base..HEAD").code).toBe(0);
    const ro = mkdtempSync(join(tmpdir(), "dak-ro-"));
    Bun.spawnSync(["bun", CLI, "init", "--readers", "me:person,atlas"], { env: { ...process.env, DAK_HOME: ro } });
    Bun.spawnSync(["chmod", "-R", "a-w", ro]);
    const p = Bun.spawnSync(["bun", CLI, "inbox", "--for", "atlas", "--unread", "--json"], { env: { ...process.env, DAK_HOME: ro }, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["chmod", "-R", "u+w", ro]);
    rmSync(ro, { recursive: true, force: true });
    expect([p.exitCode, p.stdout.toString().trim(), p.stderr.toString()]).toEqual([0, "[]", ""]);
  });
});

describe("chapters a reader can hold", () => {
  test("a chapter over 6 files is refused at send and named by check; --allow-big lets it through with the reason on it", () => {
    const parts = Array.from({ length: 7 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -1 +1 @@\n-a\n+b\n`).join("");
    writeFileSync(join(repo, "big.diff"), parts);
    writeFileSync(join(repo, "big.json"), JSON.stringify([{ title: "Everything", summary: "All of it.", risk: "low", hunks: Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.ts`, start: 1 })) }]));
    const sent = dak("send", "--to", "sam", "--from", "atlas", "--diff", "big.diff", "--chapters", "big.json", "--subject", "Big", "--json").json();
    expect(sent.error.code).toBe("big_chapters");
    expect(sent.error.message).toContain("7 files");
    const check = dak("chapters", "check", "big.json", "--diff", "big.diff");
    expect(check.code).toBe(1);
    expect(dak("chapters", "check", "big.json", "--diff", "big.diff", "--allow-big", "one rename across the folder").code).toBe(0);
    const ok = dak("send", "--to", "sam", "--from", "atlas", "--diff", "big.diff", "--chapters", "big.json", "--subject", "Big", "--allow-big", "one rename across the folder", "--json").json();
    expect(ok.message.attachments[0].meta.chapters[0].big_why).toBe("one rename across the folder");
  });
});

describe("code hopping", () => {
  test("a name's definition comes from the PR's files and the repo at its head, with the places that use it", async () => {
    writeFileSync(join(repo, "lib.ts"), "export function helperOne(x: number) {\n  return x + 1;\n}\n");
    writeFileSync(join(repo, "use.ts"), "import { helperOne } from './lib';\nexport const two = helperOne(1);\n");
    git("add", "."); git("commit", "-qm", "lib");
    const sent = dak("send", "--to", "sam", "--from", "atlas", "--base", "main", "--subject", "Hop", "--json").json();
    const att = sent.message.attachments[0].id;
    const r = await (await http(`/v1/lookup?thread=${sent.thread_id}&att=${att}&name=helperOne`)).json();
    expect(r.defs.map((d: any) => [d.file, d.line])).toEqual([["lib.ts", 1]]);
    expect(r.defs[0].snippet.lines[0]).toContain("export function helperOne");
    expect(r.refs.map((x: any) => x.file).sort()).toEqual(["use.ts", "use.ts"]);
    const sn = await (await http(`/v1/lookup?thread=${sent.thread_id}&att=${att}&file=use.ts&line=2`)).json();
    expect(sn.lines.join("\n")).toContain("helperOne(1)");
    expect((await (await http(`/v1/lookup?thread=${sent.thread_id}&att=${att}&name=${encodeURIComponent("a b")}`)).json()).error.code).toBe("bad_name");
  });
});

describe("pins", () => {
  test("an agent pinned stays pinned, in the order pinned, and can be unpinned", async () => {
    const put = (peer: string, on: boolean) => http("/v1/pins", { method: on ? "PUT" : "DELETE", body: JSON.stringify({ peer }) }).then((r) => r.json());
    await put("atlas", true);
    const both = await put("mitra", true);
    expect(Object.keys(both)).toEqual(["atlas", "mitra"]);
    expect(Object.keys(await put("atlas", false))).toEqual(["mitra"]);
    expect(Object.keys(await (await http("/v1/pins")).json())).toEqual(["mitra"]);
  });
});

describe("several PRs on one thread", () => {
  // A stand-in for gh: `gh pr view N` and `gh pr diff N` answer for any number, and FAKE_GH_V
  // makes a new head, as a push would.
  const bin = join(home, "fakebin");
  beforeAll(() => {
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "gh"), `#!/bin/sh
n="$3"
if [ "$1 $2" = "pr view" ]; then echo "{\\"number\\":$n,\\"title\\":\\"PR $n\\",\\"url\\":\\"https://example.test/pull/$n\\",\\"headRefOid\\":\\"head$n$FAKE_GH_V\\",\\"baseRefOid\\":\\"base\\",\\"baseRefName\\":\\"main\\"}"; exit 0; fi
if [ "$1 $2" = "pr diff" ]; then printf 'diff --git a/f%s.ts b/f%s.ts\\n--- a/f%s.ts\\n+++ b/f%s.ts\\n@@ -1 +1 @@\\n-a\\n+b%s\\n' "$n" "$n" "$n" "$n" "$FAKE_GH_V"; exit 0; fi
exit 1
`);
    Bun.spawnSync(["chmod", "+x", join(bin, "gh")]);
  });
  const gh = (v: string, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", CLI, ...args], { env: { ...process.env, DAK_HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_V: v }, cwd: repo, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), json: () => JSON.parse(p.stdout.toString()) };
  };
  const threeOnOne = () => {
    const { thread } = gh("", "send", "--to", "sam", "--from", "atlas", "--pr", "5001", "--subject", "Attendance", "--json").json();
    gh("", "reply", thread.id, "--from", "atlas", "--pr", "5002");
    gh("", "reply", thread.id, "--from", "atlas", "--pr", "5003");
    return thread.id as string;
  };
  const prsOf = (id: string) => dak("show", id, "--json").json().prs.map((p: any) => [p.number, p.versions, p.verdict]);

  test("each number is its own PR, not a new version of the first", () => {
    const id = threeOnOne();
    expect(prsOf(id)).toEqual([[5001, 1, null], [5002, 1, null], [5003, 1, null]]);
  });

  test("approving the whole thread is refused when it carries several PRs; approving one approves only that one", async () => {
    const id = threeOnOne();
    const all = dak("reply", id, "--from", "sam", "--verdict", "approve", "Go.");
    expect(all.code).not.toBe(0);
    expect(all.err).toContain("This thread has 3 PRs");
    expect(prsOf(id).map((p: any) => p[2])).toEqual([null, null, null]);

    expect(dak("reply", id, "--from", "sam", "--verdict", "approve", "--on", "5002", "This one.").code).toBe(0);
    expect(prsOf(id)).toEqual([[5001, 1, null], [5002, 1, "approve"], [5003, 1, null]]);
    // The thread is still waiting on sam: two PRs have no verdict.
    expect(dak("show", id, "--json").json().thread.status).toBe("waiting");
    const reviews = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    expect(reviews.find((r) => r.thread_id === id)?.type).toBe("pr");
    // Verdicts on the other two answer it.
    dak("reply", id, "--from", "sam", "--verdict", "changes", "--on", "5001", "Rename it.");
    expect(dak("show", id, "--json").json().thread.status).toBe("waiting");
    dak("reply", id, "--from", "sam", "--verdict", "approve", "--on", "5003", "Fine.");
    expect(dak("show", id, "--json").json().thread.status).toBe("answered");
    // The agent's note names the PR, and what stands approved.
    const note = dak("wait", id, "--for", "atlas", "--timeout", "2s").out;
    expect(note).toContain("approved #5002");
    // A PR not on the thread is refused, not silently ignored.
    expect(dak("reply", id, "--from", "sam", "--verdict", "approve", "--on", "9999").err).toContain("carries no #9999");
  });

  test("a new version of one PR clears only its own approval", () => {
    const id = threeOnOne();
    dak("reply", id, "--from", "sam", "--verdict", "approve", "--on", "5001,5002", "Both.");
    expect(prsOf(id).map((p: any) => p[2])).toEqual(["approve", "approve", null]);
    gh("v2", "reply", id, "--from", "atlas", "--pr", "5001", "Pushed a fix.");
    expect(prsOf(id)).toEqual([[5001, 2, null], [5002, 1, "approve"], [5003, 1, null]]);
  });

  test("the merge queue reads each row's own PR: only the approved one says approved", () => {
    const id = threeOnOne();
    dak("reply", id, "--from", "sam", "--verdict", "approve", "--on", "5002", "This one.");
    for (const n of ["5001", "5002", "5003"]) dak("queue", "set", n, "--state", "approved", "--title", `P${n}`, "--thread", id);
    const rows = dak("queue", "--json").json().filter((r: any) => [5001, 5002, 5003].includes(r.pr));
    expect(rows.map((r: any) => [r.pr, !!r.approval])).toEqual([[5001, false], [5002, true], [5003, false]]);
    // What it approved is #5002's head, not the thread's newest PR's.
    expect(rows.find((r: any) => r.pr === 5002).approval.head_sha).toBe("head5002");
  });

  test("one PR on a thread approves as before, with no number needed", () => {
    const { thread } = gh("", "send", "--to", "sam", "--from", "atlas", "--pr", "5101", "--subject", "Solo", "--json").json();
    expect(dak("reply", thread.id, "--from", "sam", "--verdict", "approve", "Go.").code).toBe(0);
    expect(prsOf(thread.id)).toEqual([[5101, 1, "approve"]]);
  });
});

describe("reading older verdicts", () => {
  test("an approval that named no PR, on a thread already carrying several, approves none of them", async () => {
    const { prStates } = await import("../src/verdicts");
    const pr = (id: string, n: number) => ({ id, type: "pr", name: `PR #${n}`, meta: { number: n, title: `P${n}`, head_sha: `h${n}`, diff_blob: `d${n}` } });
    const msg = (id: number, author: string, extra: any) => ({ id, thread_id: "t", author, body: "", verdict: null, created_at: `2026-11-17T00:00:0${id}Z`, attachments: [], comments: [], ...extra });
    const one = [msg(1, "atlas", { attachments: [pr("a1", 1)] }), msg(2, "sam", { verdict: "approve" })];
    expect(prStates(one as any, ["sam"]).map((p) => p.verdict)).toEqual(["approve"]); // one PR: as before
    const two = [msg(1, "atlas", { attachments: [pr("a1", 1), pr("a2", 2)] }), msg(2, "sam", { verdict: "approve" })];
    expect(prStates(two as any, ["sam"]).map((p) => p.verdict)).toEqual([null, null]);
    const changes = [...two.slice(0, 1), msg(2, "sam", { verdict: "changes" })];
    expect(prStates(changes as any, ["sam"]).map((p) => p.verdict)).toEqual(["changes", "changes"]); // asking for changes still covers all
  });
});

describe("updates don't interrupt", () => {
  const hook = (input: object) => {
    const p = Bun.spawnSync(["bun", CLI, "hook", "claude-code"], { env: { ...process.env, DAK_HOME: home }, stdin: new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe" });
    return p.stdout.toString();
  };
  const cwd = "/tmp/work/quiet-agent-4f1e2d", me = "quiet-agent-4f1e2d";

  test("an update waits for the next turn instead of reopening this one; a question still reopens it", () => {
    hook({ hook_event_name: "SessionStart", cwd, session_id: "q1" });
    const { thread } = dak("send", "--to", me, "--from", "sam", "--subject", "FYI", "--fyi", "Thanks, used it in the script.", "--json").json();
    expect(dak("show", thread.id, "--json").json().messages[0].quiet).toBe(true);
    // At the stop: nothing, so the turn ends.
    expect(hook({ hook_event_name: "Stop", cwd, session_id: "q1" })).toBe("");
    // At the next turn's start it is there, marked as an update, with no reply line.
    const next = hook({ hook_event_name: "UserPromptSubmit", cwd, session_id: "q1" });
    expect(next).toContain("Thanks, used it in the script.");
    expect(next).toContain("no reply needed");
    expect(next).not.toContain("Reply with");

    // A question at the stop still blocks it, and carries any update along with it.
    dak("reply", thread.id, "--from", "sam", "--fyi", "Also posted.");
    dak("send", "--to", me, "--from", "sam", "--subject", "Q", "Which video goes first?");
    const stop = JSON.parse(hook({ hook_event_name: "Stop", cwd, session_id: "q1" }));
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("Which video goes first?");
    expect(stop.reason).toContain("Also posted.");
  });

  test("the sender's text after an approval is an update; the reader's answer is not", () => {
    const { thread } = dak("send", "--to", "sam", "--from", me, "--diff", "d2.diff", "--subject", "Quiet PR", "--json").json();
    dak("reply", thread.id, "--from", "sam", "--verdict", "approve", "Go.");
    const after = dak("reply", thread.id, "--from", me, "Merged.", "--json").json();
    expect(after.quiet).toBe(true);
    const answer = dak("reply", thread.id, "--from", "sam", "Thanks, now deploy it.", "--json").json();
    expect(answer.quiet).toBeUndefined();
  });
});

describe("reviewing and removing", () => {
  test("I'm reviewing names a PR, and Stop says you put it down; the topic stays waiting on you", async () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--diff", "d2.diff", "--subject", "Read me", "--json").json();
    dak("reviewing", thread.id, "--from", "sam", "--on", "2462");
    let mine = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    expect(mine.find((r) => r.thread_id === thread.id)?.reviewing_since).toBeTruthy();
    expect(dak("show", thread.id, "--json").json().messages.at(-1).body).toBe("Reviewing #2462 now.");
    await http(`/v1/threads/${thread.id}/reviewing`, { method: "POST", body: JSON.stringify({ author: "sam", stop: true }) });
    mine = (await (await http("/v1/reviews?for=sam")).json()) as any[];
    const row = mine.find((r) => r.thread_id === thread.id);
    expect(row).toBeTruthy(); // still waiting on sam
    expect(row.reviewing_since).toBeNull();
    const last = dak("show", thread.id, "--json").json().messages.at(-1);
    expect([last.reviewing, last.quiet]).toEqual([false, true]); // an update to atlas, not a question
  });

  test("an attachment taken off a topic is kept and can be restored; a removed PR stops counting", async () => {
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--diff", "d2.diff", "--subject", "Merged one", "--json").json();
    const att = dak("show", thread.id, "--json").json().messages[0].attachments[0].id;
    const off = await (await http(`/v1/threads/${thread.id}/attachments/${att}`, { method: "POST", body: JSON.stringify({ author: "sam" }) })).json();
    expect(off.messages[0].attachments[0].hidden).toBe(true);
    expect(off.prs).toEqual([]);
    const back = await (await http(`/v1/threads/${thread.id}/attachments/${att}`, { method: "POST", body: JSON.stringify({ author: "sam", hidden: false }) })).json();
    expect(back.messages[0].attachments[0].hidden).toBeUndefined();
    expect(back.prs.length).toBe(1);
    expect((await http(`/v1/threads/${thread.id}/attachments/a_nope`, { method: "POST", body: "{}" })).status).toBe(404);
  });
});

describe("the team and @mentions", () => {
  test("everyone who works through Dak is on the team, and the person's card wins over the guess", async () => {
    dak("send", "--to", "sam", "--from", "builder-one", "--subject", "Hi", "hello");
    let list = dak("team", "--all", "--json").json(); // the test runs in a temporary folder, which the plain list hides
    expect(list.find((m: any) => m.name === "builder-one")?.kind).toBe("local");
    expect(list[0].name).toBe("sam"); // the person first
    dak("team", "set", "builder-one", "--display", "Builder", "--role", "Engineer", "--area", "Registers", "--cannot", "no production access");
    list = dak("team", "--all", "--json").json();
    expect(list.find((m: any) => m.name === "builder-one")).toMatchObject({ display: "Builder", role: "Engineer", area: "Registers", cannot: "no production access" });
    expect(dak("team", "set", "nobody-at-all", "--role", "x").code).not.toBe(0);
    const viaHttp = await (await http("/v1/team/builder-one", { method: "PUT", body: JSON.stringify({ can: "writes code" }) })).json();
    expect(viaHttp.can).toBe("writes code");
  });

  test("an @mention brings a member onto the topic from that message on, not the history", () => {
    dak("send", "--to", "sam", "--from", "builder-two", "--subject", "Seen", "hello"); // builder-two exists
    const { thread } = dak("send", "--to", "sam", "--from", "atlas", "--subject", "Plan", "First, the old part.", "--json").json();
    dak("reply", thread.id, "--from", "sam", "Second note, before anyone is mentioned.");
    const m = dak("reply", thread.id, "--from", "sam", "@builder-two can you take the registers part? Not @types/node or x@y.com.", "--json").json();
    expect(m.mentions).toEqual(["builder-two"]);
    const t = dak("show", thread.id, "--json").json();
    expect(t.participants.some((p: any) => p.name === "builder-two")).toBe(true);
    const mail = dak("inbox", "--for", "builder-two", "--unread", "--json").json();
    const here = mail.filter((x: any) => x.thread_id === thread.id).map((x: any) => x.body);
    expect(here).toEqual([m.body]); // only the mention, not "First" or "Second"
    // In the first message of a new topic, too.
    const { thread: t2 } = dak("send", "--to", "atlas", "--from", "sam", "--subject", "Kickoff", "@builder-two and @atlas, start here.", "--json").json();
    expect(dak("show", t2.id, "--json").json().participants.map((p: any) => p.name)).toContain("builder-two");
  });
});

describe("the Board", () => {
  test("assigning a ticket puts it in the agent's pile, tells the agent and Atlas, and its stage follows the work", async () => {
    dak("send", "--to", "sam", "--from", "board-eng", "--subject", "Hello", "hi"); // board-eng is on the team
    const a = dak("task", "add", "Attendance photo check", "--json").json();
    const b = dak("task", "add", "Attendance export", "--json").json();
    dak("assign", a.id, "board-eng", "--from", "sam");
    dak("assign", b.id, "board-eng", "--before", a.id, "--from", "sam");
    expect(dak("pile", "--for", "board-eng", "--json").json().map((c: any) => c.id)).toEqual([b.id, a.id]);
    // The agent got told, and so did Atlas (as an update).
    const mail = dak("inbox", "--for", "board-eng", "--unread", "--json").json().map((m: any) => m.body);
    expect(mail.some((x: string) => x.includes(`You're on ${a.id}`))).toBe(true);
    const atlas = dak("inbox", "--for", "atlas", "--unread", "--json").json().filter((m: any) => m.body.includes(`gave ${a.id}`));
    expect(atlas[0]?.quiet).toBe(true);
    // Next takes the top of the pile and starts it; a status line sets the note.
    const nx = dak("next", "--for", "board-eng", "--json").json();
    expect([nx.id, nx.stage, nx.now]).toEqual([b.id, "next", true]);
    const st = dak("status", b.id, "wiring the export", "--for", "board-eng", "--json").json();
    expect([st.stage_note, st.now]).toEqual(["wiring the export", true]);
    // A line on another ticket makes that one Now; one Now per engineer.
    dak("status", a.id, "looking at the photo check", "--for", "board-eng");
    let pile = dak("pile", "--for", "board-eng", "--json").json();
    expect(pile.filter((c: any) => c.now).map((c: any) => c.id)).toEqual([a.id]);
    // Blocked is blocked, never Now; blocked on the person is "you".
    const bl = dak("status", a.id, "need the photo rules", "--blocked", "Pratik's call on the rules", "--for", "board-eng", "--json").json();
    expect([bl.stage, bl.now, bl.needs_you]).toEqual(["blocked", false, false]); // nothing on Dak to answer yet
    const bl2 = dak("status", a.id, "waiting on the vendor", "--blocked", "the vendor's API key", "--for", "board-eng", "--json").json();
    expect([bl2.stage, bl2.now]).toEqual(["blocked", false]);
    dak("status", b.id, "wiring the export", "--for", "board-eng");
    // A topic naming the ticket is its work; a PR waiting on the person makes it "you", approval "approved".
    const { thread } = dak("send", "--to", "sam", "--from", "board-eng", "--diff", "d2.diff", "--subject", `${b.id}: the export`, "--json").json();
    let card = dak("board", "--json").json().cards.find((c: any) => c.id === b.id);
    expect([card.stage, card.needs_you, card.work.length]).toEqual(["you", true, 1]);
    dak("reply", thread.id, "--from", "sam", "--verdict", "approve", "Go.");
    card = dak("board", "--json").json().cards.find((c: any) => c.id === b.id);
    expect(card.stage).toBe("approved");
    // Back to the backlog.
    // A batch topic that carries this ticket's PR does not make it "needs you": only its own topic does.
    const batch = dak("send", "--to", "sam", "--from", "board-eng", "--diff", "d2.diff", "--subject", "Batch of three", "--json").json();
    expect(batch.thread.id).toBeTruthy();
    dak("assign", a.id, "none");
    expect(dak("pile", "--for", "board-eng", "--json").json().map((c: any) => c.id)).toEqual([b.id]);
    expect(dak("assign", a.id, "nobody-here").code).not.toBe(0);
  });

  test("the Linear reader copies open tickets with labels and milestone, and rejects a bad key without keeping it", async () => {
    const { setLinearKey, syncLinear, linearKey, clearLinearKey } = await import("../src/linear");
    const fake = async (_u: string, init: RequestInit) => {
      const q = JSON.parse(String(init.body)).query as string;
      if (q.includes("viewer")) return new Response(JSON.stringify({ data: { viewer: { name: "Sam" } } }));
      return new Response(JSON.stringify({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { identifier: "REVA-9001", title: "Dress check", url: "https://linear.app/x/REVA-9001", priority: 2, updatedAt: new Date().toISOString(),
          state: { name: "Todo", type: "unstarted" }, labels: { nodes: [{ name: "attendance" }] }, project: { name: "North Star" }, projectMilestone: { name: "M21" }, team: { key: "REVA" } },
        { identifier: "REVA-9002", title: "Checking one", url: null, priority: 0, updatedAt: new Date().toISOString(),
          state: { name: "Checking", type: "started" }, labels: { nodes: [] }, project: null, projectMilestone: null, team: { key: "REVA" } },
      ] } } }));
    };
    await expect(setLinearKey("not-a-key", fake as any)).rejects.toThrow("lin_api_");
    expect(linearKey()).toBeNull();
    await setLinearKey("lin_api_" + "a".repeat(40), fake as any);
    expect(linearKey()).toBe("lin_api_" + "a".repeat(40));
    expect((await syncLinear(fake as any)).count).toBe(2);
    const cards = dak("board", "--json").json().cards;
    expect(cards.find((c: any) => c.id === "REVA-9001")).toMatchObject({ labels: ["attendance"], milestone: "M21", stage: "backlog" });
    expect(cards.find((c: any) => c.id === "REVA-9002").stage).toBe("backlog"); // Linear's own status no longer sets the stage; only Done takes it off
    clearLinearKey();
  });
});

describe("setting up the Board in bulk", () => {
  test("a plan file assigns many tickets in pile order, tells each agent once, and names who assigned them", () => {
    dak("send", "--to", "sam", "--from", "bulk-a", "--subject", "Hi", "hi");
    dak("send", "--to", "sam", "--from", "bulk-b", "--subject", "Hi", "hi");
    const ids = [1, 2, 3, 4].map((i) => dak("task", "add", `Bulk ticket ${i}`, "--json").json().id);
    writeFileSync(join(repo, "plan.txt"), `# setup\n${ids[2]} bulk-a\n${ids[0]} bulk-a\n${ids[1]} bulk-b\n${ids[3]} bulk-b\n`);
    const r = dak("assign", "--file", "plan.txt", "--from", "atlas", "--json").json();
    expect(r).toEqual({ assigned: 4, agents: { "bulk-a": 2, "bulk-b": 2 } });
    expect(dak("pile", "--for", "bulk-a", "--json").json().map((c: any) => c.id)).toEqual([ids[2], ids[0]]);
    const mail = dak("inbox", "--for", "bulk-a", "--unread", "--json").json().filter((m: any) => m.body.includes("put 2 tickets"));
    expect(mail.length).toBe(1);
    expect(mail[0].author).toBe("atlas");
    expect(dak("show", dak("pile", "--for", "bulk-a", "--json").json()[0].work[0]?.thread ?? mail[0].thread_id, "--json").json().thread.from).toBe("atlas");
    // A bad line stops the whole plan before anything changes.
    writeFileSync(join(repo, "bad.txt"), `${ids[0]} bulk-b\nNOPE-1 bulk-a\n`);
    const bad = dak("assign", "--file", "bad.txt");
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain("no ticket NOPE-1");
    expect(dak("pile", "--for", "bulk-b", "--json").json().map((c: any) => c.id)).toEqual([ids[1], ids[3]]);
    // Quiet: nobody is told.
    const t5 = dak("task", "add", "Quiet one", "--json").json().id;
    dak("assign", t5, "bulk-b", "--quiet", "--from", "atlas");
    expect(dak("inbox", "--for", "bulk-b", "--unread", "--json").json().filter((m: any) => m.body.includes(t5)).length).toBe(0);
  });
});
