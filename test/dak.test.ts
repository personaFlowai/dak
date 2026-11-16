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
  test("merge scripts push state; the queue keeps join order, finished ones last, and refuses an unknown state", async () => {
    expect(dak("queue", "set", "2427", "--state", "approved", "--head", "abc1234", "--migration", "20261116_x.sql", "--title", "Needs-you").code).toBe(0);
    dak("queue", "set", "#2425", "--state", "approved", "--title", "Register reads");
    dak("queue", "set", "2427", "--state", "testing", "--note", "full suite, 4 min");
    expect(dak("queue", "set", "2427", "--state", "shipped", "--json").json().error.code).toBe("bad_state");
    let rows = dak("queue", "--json").json();
    expect(rows.map((r: any) => [r.pr, r.state])).toEqual([[2427, "testing"], [2425, "approved"]]);
    expect(rows[0]).toMatchObject({ head: "abc1234", migration: "20261116_x.sql", note: "full suite, 4 min" });
    dak("queue", "set", "2427", "--state", "deployed");
    rows = (await (await http("/v1/queue")).json()) as any[];
    expect(rows.map((r: any) => r.pr)).toEqual([2425, 2427]);
    expect(rows[1].note).toBeNull(); // a new state clears the old note
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
