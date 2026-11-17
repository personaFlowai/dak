import { buildCost, parseParticipant } from "./handoff";
import { lookup, snippet } from "./lookup";
import { tickRunners } from "./reviewer";
import { closePhone, cookieKey, isPhoneKey, openPhone, phoneHost, phoneMayNot, phoneStatus } from "./phone";
import { recentWakes, settleWakes, tickSleepers } from "./sleeper";
import { next, queue, queueStamp, removeQueue, setQueue } from "./queue";
import { describeReview, orderQueue, orderReviews, prioritizeQueue, prioritizeReview, reviewsInOrder, tierOf } from "./priority";
import type { Participant } from "./types";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, person, token } from "./config";
import {
  addMessage, blobPath, store, createThread, getThread, latestMessageId, listThreads, markRead, putBlob,
  requireReader, takeUnread, archives, setArchived, pins, setPinned, setStatus, search, type NewAttachment, type NewComment,
  addParticipant, decisions, groups, setGroup, awaitingReview,
} from "./store";
import { explain, ask } from "./explain";
import { HELPERS, setHelper, setModel, setCodexListen, setWakeClosed, writeConfig, type HelperName } from "./config";
import { connected, connect, disconnect, ensureCodexListenTimeout, type HookTool } from "./claude-hooks";
import { codexDefaultModel } from "./presence";
import { postReview } from "./github";
import { waitForMail } from "./wake";
import { INSTRUCTIONS, installSkill } from "./skill";
import { snapshotPr } from "./pr";
import { agentForKey, agentKey, closeDoor, doorStatus, instructionsFor, openDoor, revokeKey } from "./tunnel";
import type { PrMeta } from "./types";
import { agents, touch } from "./presence";
import { DakError, type Verdict } from "./types";
// Embedded at compile time, so the single dak binary carries its own screens.
import indexHtml from "../dist/ui/index.html" with { type: "text" };
import appJs from "../dist/ui/app.js" with { type: "text" };
import styleCss from "../dist/ui/style.css" with { type: "text" };
import touchIcon from "../ui/apple-touch-icon.png" with { type: "file" };
import icon512 from "../ui/icon-512.png" with { type: "file" };

// DAK_DEV=1 reads the screens from dist/ui on every request, so a rebuild shows without a restart.
const asset = (file: string, embedded: string) =>
  process.env.DAK_DEV ? readFileSync(join(import.meta.dir, "..", "dist", "ui", file), "utf8") : embedded;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const fail = (e: unknown) => {
  if (e instanceof DakError) return json({ error: { code: e.code, message: e.message } }, e.status);
  console.error(e);
  return json({ error: { code: "internal", message: "Something went wrong inside Dak. The server log has the details." } }, 500);
};

export function serve(port?: number) {
  const cfg = loadConfig();
  // A connected tool's copy of the Dak instructions follows this version of Dak.
  for (const t of ["claude", "codex"] as const) { try { if (connected(t)) installSkill(t); } catch { /* never block the server */ } }
  const p = port ?? cfg.port;
  const secret = token();
  // Reviewer runners pick up what was sent to them. A tick is one indexed query per runner.
  settleWakes();
  let ticks = 0;
  const ticker = setInterval(() => {
    try { tickRunners(); } catch { /* never stop the server */ }
    if (++ticks % 3 === 0) try { tickSleepers(); } catch { /* same */ } // closed sessions: every 6 s is soon enough
  }, 2000);
  ticker.unref?.();
  const allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);

  return Bun.serve({
    hostname: "127.0.0.1",
    port: p,
    idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url);
      // A wake request waits for hours; Bun's idle timeout would cut it after a minute.
      if (url.pathname === "/v1/wake") server.timeout(req, 0);
      if (url.pathname.startsWith("/x/")) {
        try { return await outside(req, url); } catch (e) { return fail(e); }
      }
      // Through the phone tunnel: only a request carrying the phone's key gets anywhere.
      if (!allowedHosts.has(req.headers.get("host") ?? "") || req.headers.has("cf-ray")) {
        try { return await phoneRequest(req, url); } catch (e) { return fail(e); }
      }
      // A page on another site can point a request here (or rebind a domain to
      // 127.0.0.1); checking Host and Origin refuses both before anything runs.
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("Wrong host", { status: 403 });
      const origin = req.headers.get("origin");
      if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ""))) return new Response("Wrong origin", { status: 403 });

      try {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const c = loadConfig();
          const boot = `<script>window.DAK=${JSON.stringify({ token: secret, me: person(c), readers: c.readers })}</script>`;
          return new Response(asset("index.html", indexHtml as unknown as string).replace("<!--BOOT-->", boot), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        }
        if (url.pathname === "/app.js") return new Response(asset("app.js", appJs), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } }); // an update must reach an open window
        const file = appFiles(url); if (file) return file;
        if (url.pathname === "/style.css") return new Response(asset("style.css", styleCss), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
        if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });

        const auth = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
        if (auth !== secret) throw new DakError("unauthorised", "Send the token from ~/.dak/token as: Authorization: Bearer <token>", 401);
        return await api(req, url);
      } catch (e) {
        return fail(e);
      }
    },
  });
}

/* The person's phone, through its tunnel. The first visit is the link from the QR code,
   /m?k=<key>, which sets a cookie and drops the key from the address. After that every
   request must carry the key (the cookie, or the page's own Authorization header). The
   page is the same one the Mac shows, told it is on a phone. */
// The icon and the manifest a phone reads to put Dak on its home screen. Nothing private,
// so they are served without a key: iOS fetches them on its own.
function appFiles(url: URL): Response | null {
  if (url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png") return new Response(Bun.file(touchIcon), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  if (url.pathname === "/icon-512.png") return new Response(Bun.file(icon512), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  if (url.pathname === "/manifest.webmanifest") return Response.json({ name: "Dak", short_name: "Dak", start_url: "/", display: "standalone", background_color: "#ffffff", theme_color: "#1f6f8b",
    icons: [{ src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }] }, { headers: { "content-type": "application/manifest+json" } });
  return null;
}

async function phoneRequest(req: Request, url: URL): Promise<Response> {
  const host = req.headers.get("host") ?? "";
  const ph = phoneHost();
  if (!ph || host !== ph) return new Response("Wrong host", { status: 403 });
  const origin = req.headers.get("origin");
  if (origin && origin !== `https://${ph}`) return new Response("Wrong origin", { status: 403 });
  const file = appFiles(url); if (file) return file;
  if (url.pathname === "/m") {
    const k = url.searchParams.get("k");
    if (!isPhoneKey(k)) return new Response("This link has expired. Scan the code in Dak's Settings again.", { status: 401 });
    return new Response(null, { status: 303, headers: { location: "/",
      "set-cookie": `dak_phone=${encodeURIComponent(k!)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` } });
  }
  const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
  const key = isPhoneKey(bearer) ? bearer : isPhoneKey(cookieKey(req)) ? cookieKey(req) : null;
  if (!key) return new Response("Sign in by scanning the code in Dak's Settings on your Mac.", { status: 401 });
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const c = loadConfig();
    const boot = `<script>window.DAK=${JSON.stringify({ token: key, me: person(c), readers: c.readers, phone: true })}</script>`;
    return new Response(asset("index.html", indexHtml as unknown as string).replace("<!--BOOT-->", boot), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  if (url.pathname === "/app.js") return new Response(asset("app.js", appJs), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
  if (url.pathname === "/style.css") return new Response(asset("style.css", styleCss), { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
  if (!url.pathname.startsWith("/v1/")) return new Response("Not found", { status: 404 });
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  if (phoneMayNot(req.method, parts)) throw new DakError("not_from_phone", "That is set on the Mac, not from the phone.", 403);
  return await api(req, url);
}

// The only routes reachable through a tunnel. The caller is whoever its agent key
// names; it sends as that agent, to the person, and reads only its own threads.
async function outside(req: Request, url: URL): Promise<Response> {
  const agent = agentForKey(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null);
  if (!agent) throw new DakError("unauthorised", "Send your Dak key as: Authorization: Bearer <key>", 401);
  const parts = url.pathname.split("/").filter(Boolean).slice(1);
  const me = person(loadConfig());
  const body = async () => {
    const text = await req.text();
    if (text.length > 64_000) throw new DakError("too_large", "Keep a message under 64 KB.", 413);
    try { return JSON.parse(text || "{}"); } catch { throw new DakError("bad_json", "The request body must be JSON."); }
  };
  // One key can speak for several bots (Grok's Orbit, Nova...): each sends under its own name,
  // and everything addressed to any of them comes back on this key.
  const tool = "grok" === agent ? "grok" : "http";
  const names = [agent, ...botsOf(agent)];
  const sideOf = (t: { from: string; to: string }) => names.find((n) => n === t.from || n === t.to);
  const ownThread = (id: string) => {
    const t = getThread(id).thread;
    if (!sideOf(t)) throw new DakError("no_thread", `No thread ${id}.`, 404);
    return t;
  };
  const as = (b: any) => {
    const n = b?.from ? String(b.from).trim().toLowerCase() : agent;
    if (names.includes(n)) return n;
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(n)) throw new DakError("bad_name", "A bot's name is letters, digits, - and _.");
    if (loadConfig().readers.some((r) => r.name === n)) throw new DakError("taken", `"${n}" is a reader on this Mac; pick another name for your bot.`, 403);
    if (!claimBot(n, agent)) throw new DakError("taken", `"${n}" belongs to another key.`, 403);
    names.push(n);
    return n;
  };
  touch(agent, { tool });
  if (parts[0] === "send" && req.method === "POST") {
    const b = await body();
    const atts = b.link ? [{ type: "link", name: String(b.link), meta: { url: String(b.link) } } as any] : [];
    // To the person by default; to any agent by name ("zari", "atlas"), so a remote agent can
    // work with the team directly. It still reads only its own threads.
    const to = b.to ? String(b.to).toLowerCase() : me;
    if (to !== me && loadConfig().readers.some((r) => r.name === to && r.kind === "person")) throw new DakError("not_allowed", "An outside agent writes to the person or to agents.", 403);
    const from = as(b); touch(from, { tool });
    const made = createThread({ to, from, subject: String(b.subject ?? "").slice(0, 200) || String(b.body ?? "").split("\n")[0].slice(0, 80), kind: "note", body: String(b.body ?? ""), attachments: atts,
      options: optionsOf(b), extra: { cost: costOf(b) }, ...(b.needs_reply === false || b.fyi === true ? { needs_reply: false } : {}) });
    askedAs(made.thread.id, from, b);
    return json(made, 201);
  }
  // Re-rank or re-describe one of its own asks after sending it.
  if (parts[0] === "priority" && parts[1] && req.method === "PUT") {
    ownThread(parts[1]);
    askedAs(parts[1], agent, await body());
    return json({ ok: true });
  }
  if (parts[0] === "reply" && parts[1] && req.method === "POST") {
    ownThread(parts[1]);
    const b = await body();
    // A reply goes out as whichever of its bots is on the thread, unless it names one.
    const t = ownThread(parts[1]);
    const author = b.from ? as(b) : sideOf(t)!;
    const m = addMessage(parts[1], { author, body: String(b.body ?? ""), options: optionsOf(b), extra: { cost: costOf(b) },
      ...(b.needs_reply === false || b.fyi === true || b.done === true ? { needs_reply: false } : {}) });
    askedAs(parts[1], agent, b);
    if (b.done === true) setStatus(parts[1], "closed");
    return json(m, 201);
  }
  if (parts[0] === "wait" && parts[1] && req.method === "GET") {
    ownThread(parts[1]);
    const deadline = Date.now() + Math.min(Number(url.searchParams.get("timeout") ?? 25), 55) * 1000;
    while (Date.now() < deadline) {
      const msgs = takeUnread(sideOf(getThread(parts[1]).thread)!, { threadId: parts[1] });
      if (msgs.length) return json({ messages: msgs });
      await Bun.sleep(700);
    }
    return json({ messages: [], timed_out: true });
  }
  // Mail for every bot on this key; each message says which thread, and the thread says to whom.
  if (parts[0] === "inbox" && req.method === "GET") return json(names.flatMap((n) => takeUnread(n)).sort((a, b) => a.id - b.id));
  // Its instructions, so a remote agent can refresh them itself after Dak changes. The key is
  // not repeated: it already holds it.
  if (parts[0] === "skill" && req.method === "GET") {
    const base = `https://${req.headers.get("host") ?? ""}`;
    return new Response(instructionsFor(agent, base, "<your key>", me), { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  // Who it can write to: the person and the agents, with what each does.
  if (parts[0] === "agents" && req.method === "GET") {
    const c = loadConfig();
    return json(c.readers.filter((r) => r.name !== agent && (r.kind === "agent" || r.name === me)).map((r) => ({ name: r.name, about: r.about ?? (r.name === me ? "The person" : null) })));
  }
  throw new DakError("not_found", "The outside routes are /x/send, /x/reply/<id>, /x/wait/<id>, /x/inbox, /x/agents and /x/skill.", 404);
}

async function api(req: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // after "v1"
  const q = url.searchParams;
  const method = req.method;
  const body = async () => { try { return await req.json() as any; } catch { throw new DakError("bad_json", "The request body must be JSON."); } };

  if (parts[0] === "me" && method === "GET") {
    const c = loadConfig();
    return json({ me: person(c), readers: c.readers });
  }

  if (parts[0] === "threads" && parts.length === 1) {
    if (method === "GET") {
      const reader = q.get("for") ?? person(loadConfig());
      const box = (q.get("box") ?? "all") as any;
      return json(listThreads(reader, { box }));
    }
    if (method === "POST") {
      const b = await body();
      const atts = httpAttachments(b.attachments);
      const kind = atts.some((a) => a.type === "doc") ? "doc" : "note";
      if (b.from) touch(String(b.from), { tool: b.from === person(loadConfig()) ? null as any : "http" });
      return json(createThread({ to: b.to, from: b.from ?? "", subject: b.subject ?? "", kind, body: b.body ?? "", attachments: atts, options: optionsOf(b),
        participants: participantsOf(b), extra: { cost: costOf(b) }, ...(b.needs_reply === false ? { needs_reply: false } : {}) }), 201);
    }
  }

  if (parts[0] === "threads" && parts[1]) {
    const id = parts[1];
    if (parts.length === 2 && method === "GET") {
      const t = getThread(id);
      const readAs = q.get("read_as");
      if (readAs && t.messages.length) markRead(readAs, id, t.messages[t.messages.length - 1].id);
      return json(t);
    }
    if (parts[2] === "reviewing" && method === "POST") {
      const b = await body();
      return json(addMessage(id, { author: b.author ?? person(loadConfig()), body: String(b.body ?? "") || "Reviewing this now.", needs_reply: false, extra: { reviewing: true } }), 201);
    }
    if (parts[2] === "participants" && method === "POST") {
      const b = await body();
      let list = getThread(id).participants;
      for (const p of participantsOf(b)) list = addParticipant(id, p);
      return json(list);
    }
    // Done: the topic leaves the conversation until the agent sends something that needs you.
    if (parts[2] === "done" && method === "POST") {
      const b = await body();
      setStatus(id, b.done === false ? "answered" : "closed");
      return json(getThread(id).thread);
    }
    if (parts[2] === "messages" && method === "POST") {
      const b = await body();
      const verdict = b.verdict as Verdict | undefined;
      if (verdict && !["approve", "changes", "question"].includes(verdict)) throw new DakError("bad_verdict", "A verdict is approve, changes or question.");
      const comments: NewComment[] = Array.isArray(b.comments) ? b.comments : [];
      const message = addMessage(id, { author: b.author ?? b.from ?? "", body: b.body ?? "", verdict: verdict ?? null, comments, attachments: httpAttachments(b.attachments), options: optionsOf(b),
        ...(b.choice ? { choice: choiceOn(id, String(b.choice)) } : {}), ...(typeof b.needs_reply === "boolean" ? { needs_reply: b.needs_reply } : {}), extra: { cost: costOf(b) } });
      if (b.done === true) setStatus(id, "closed"); // the sender says the work is finished
      // Posting to GitHub happens after the reply is saved: a GitHub failure never loses the review.
      let github: { url?: string; event?: string; note?: string; error?: string } | undefined;
      if (b.github) {
        const prAtt = getThread(id).messages.flatMap((m) => m.attachments).filter((a) => a.type === "pr").pop();
        if (!prAtt) github = { error: "This thread has no PR to post to." };
        else {
          const forPr = comments.filter((c) => !c.attachment_id || c.attachment_id === prAtt.id);
          try { github = await postReview(prAtt.meta as PrMeta, b.body ?? "", verdict ?? null, forPr as any); }
          catch (e: any) { github = { error: e.message }; }
        }
      }
      return json({ ...message, ...(github ? { github } : {}) }, 201);
    }
    if (parts[2] === "wait" && method === "GET") {
      const reader = q.get("for");
      if (!reader) throw new DakError("no_reader", "Say who is waiting with ?for=<name>.");
      getThread(id);
      const deadline = Date.now() + Math.min(Number(q.get("timeout") ?? 25), 55) * 1000;
      while (Date.now() < deadline) {
        const msgs = takeUnread(reader, { threadId: id });
        if (msgs.length) return json({ thread: getThread(id).thread, messages: msgs });
        await Bun.sleep(500);
      }
      return json({ thread: getThread(id).thread, messages: [], timed_out: true });
    }
  }

  if (parts[0] === "inbox" && method === "GET") {
    const reader = q.get("for");
    if (!reader) throw new DakError("no_reader", "Say whose inbox with ?for=<name>.");
    touch(reader, { tool: "http" });
    if (q.get("unread")) return json(takeUnread(reader, { peek: q.get("peek") === "1" }));
    return json(listThreads(reader));
  }

  // Priorities. "by" is who is ordering; the person's own order wins over an agent's.
  const by = async () => { const b = await body(); return { b, who: String(b.by ?? person(loadConfig())).toLowerCase() }; };
  if (parts[0] === "reviews" && parts.length === 1 && method === "GET") return json(reviewsInOrder(q.get("for") ?? person(loadConfig())));
  if (parts[0] === "reviews" && parts[1] === "order" && method === "PUT") {
    const { b, who } = await by();
    return json(orderReviews((b.threads ?? []).map(String), who, { tier: tierOf(b.tier) }));
  }
  if (parts[0] === "reviews" && parts[1] && parts[2] === "priority" && method === "PUT") {
    const { b, who } = await by();
    if (b.tier || b.why) prioritizeReview(parts[1], who, { tier: tierOf(b.tier), why: b.why });
    describeReview(parts[1], { type: b.type, blocks: b.blocks });
    return json({ ok: true });
  }
  if (parts[0] === "queue" && parts[1] === "next" && method === "GET") return json({ next: next() });
  if (parts[0] === "queue" && parts[1] === "order" && method === "PUT") {
    const { b, who } = await by();
    return json(orderQueue((b.prs ?? []).map(Number), who, { tier: tierOf(b.tier) }));
  }
  if (parts[0] === "queue" && parts[1] && parts[2] === "priority" && method === "PUT") {
    const { b, who } = await by();
    prioritizeQueue(Number(parts[1]), who, { tier: tierOf(b.tier), why: b.why });
    return json({ ok: true });
  }
  if (parts[0] === "queue" && parts.length === 1 && method === "GET") return json(queue({ all: q.get("all") === "1" }));
  if (parts[0] === "queue" && parts[1] && method === "PUT") return json(setQueue(Number(parts[1]), await body()));
  if (parts[0] === "queue" && parts[1] && method === "DELETE") { removeQueue(Number(parts[1])); return json({ removed: Number(parts[1]) }); }
  if (parts[0] === "decisions" && method === "GET") return json(decisions(q.get("for") ?? person(loadConfig())));
  if (parts[0] === "groups" && parts.length === 1 && method === "GET") return json(groups());
  if (parts[0] === "groups" && parts[1] && method === "PUT") {
    const b = await body();
    return json({ group: parts[1], members: setGroup(parts[1], Array.isArray(b.members) ? b.members.map(String) : []) });
  }

  if (parts[0] === "wake" && method === "POST") {
    const text = await waitForMail(await body(), Number(req.headers.get("x-dak-pid") ?? 0), req.signal);
    return text ? new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } }) : new Response(null, { status: 204 });
  }
  if (parts[0] === "search" && method === "GET") {
    // Each hit carries a short window of text around the match, not a whole PR's metadata.
    const q = (url.searchParams.get("q") ?? "").trim(), low = q.toLowerCase();
    // A match inside an attachment's details (a chapter title, a key change) shows that sentence, not the raw record.
    const readable = (text: string) => {
      const brace = text.indexOf(" {");
      if (brace < 0) return text;
      try {
        const found: string[] = [];
        const walk = (v: any) => { if (typeof v === "string") { if (v.toLowerCase().includes(low)) found.push(v); } else if (v && typeof v === "object") Object.values(v).forEach(walk); };
        walk(JSON.parse(text.slice(brace + 1)));
        return found[0] ?? text.slice(0, brace);
      } catch { return text; }
    };
    return json(search(q).map((raw) => {
      const h = { ...raw, text: readable(raw.text) };
      const i = Math.max(0, h.text.toLowerCase().indexOf(low));
      const text = h.text.length > 160 ? (i > 60 ? "…" : "") + h.text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, " ") + "…" : h.text.replace(/\s+/g, " ");
      return { ...h, text };
    }));
  }
  if (parts[0] === "pins") {
    const reader = person(loadConfig());
    if (method === "GET") return json(pins(reader));
    if (method === "PUT" || method === "DELETE") { const b = await body(); return json(setPinned(reader, String(b.peer ?? ""), method === "PUT")); }
  }
  if (parts[0] === "archives") {
    const reader = person(loadConfig());
    if (method === "GET") return json(archives(reader));
    if (method === "PUT" || method === "DELETE") { const b = await body(); return json(setArchived(reader, String(b.peer ?? ""), method === "PUT")); }
  }
  if (parts[0] === "settings" && method === "GET") return json(settings());
  if (parts[0] === "settings" && method === "PUT") {
    const b = await body();
    if (b.helper) {
      if (!["claude", "codex", "cursor", "custom"].includes(b.helper)) throw new DakError("bad_helper", "The helper is claude, codex, cursor or custom.");
      setHelper(b.helper as HelperName, Array.isArray(b.command) ? b.command.map(String) : undefined);
    }
    // Keep Codex listening: the setting, and the longer Stop limit it needs in Codex's hooks.
    if (typeof b.codex_listen === "boolean") { setCodexListen(b.codex_listen); if (b.codex_listen) ensureCodexListenTimeout(); }
    if (typeof b.wake_closed === "boolean") setWakeClosed(b.wake_closed);
    if (b.model && typeof b.model === "object") {
      if (!["claude", "codex", "cursor"].includes(b.model.helper)) throw new DakError("bad_helper", "A model belongs to claude, codex or cursor.");
      try { setModel(b.model.helper, String(b.model.value ?? "")); }
      catch { throw new DakError("bad_model", "A model name is letters, digits, dots, dashes and slashes."); }
    }
    if (b.reader?.name) {
      const c = loadConfig();
      const r = c.readers.find((x) => x.name === String(b.reader.name).toLowerCase());
      if (!r) throw new DakError("unknown_reader", `No reader ${b.reader.name}.`, 404);
      for (const k of ["about", "tool", "where"] as const) {
        if (k in b.reader) { const v = String(b.reader[k] ?? "").trim(); if (v) (r as any)[k] = v; else delete (r as any)[k]; }
      }
      writeConfig(c);
    }
    return json(settings());
  }
  if (parts[0] === "connect" && (parts[1] === "claude" || parts[1] === "codex" || parts[1] === "cursor")) {
    const t = parts[1] as HookTool;
    if (method === "POST") connect(t, dakBinary());
    else if (method === "DELETE") disconnect(t);
    return json(settings());
  }

  if (parts[0] === "ask" && method === "POST") {
    const b = await body();
    if (!b.thread_id) throw new DakError("bad_request", "Ask needs thread_id.");
    return json(await ask({ thread_id: b.thread_id, question: b.question, attachment_id: b.attachment_id, file: b.file,
      side: b.side === "old" ? "old" : "new", start_line: b.start_line ? Number(b.start_line) : undefined,
      end_line: b.end_line ? Number(b.end_line) : undefined, quote: b.quote, history: Array.isArray(b.history) ? b.history.slice(-6) : [] }));
  }

  if (parts[0] === "prs" && method === "POST") {
    // Pull a GitHub PR in for review, as a thread from "github" to the person.
    const b = await body();
    const pr = String(b.pr ?? "").trim();
    if (!pr) throw new DakError("bad_request", "Give a PR number or its GitHub link.");
    const repo = String(b.repo ?? "").trim() || undefined;
    const { meta } = snapshotPr({ pr, repo });
    const me = person(loadConfig());
    return json(createThread({ to: me, from: "github", subject: meta.title ?? `PR ${pr}`, kind: "pr",
      body: String(b.note ?? ""), attachments: [{ type: "pr", name: meta.number ? `PR #${meta.number}` : "Changes", meta }] }), 201);
  }

  if (parts[0] === "door") {
    const c = loadConfig();
    if (method === "GET") return json(withInstructions(doorStatus()));
    if (method === "POST") {
      const b = await body();
      const agent = String(b.agent ?? "grok").toLowerCase();
      if (!/^[a-z0-9_-]{1,40}$/.test(agent)) throw new DakError("bad_name", "An agent name is letters, digits, - or _.");
      if (b.rotate) agentKey(agent, true);
      return json(withInstructions(await openDoor(agent, c.port, b.tool === "ngrok" ? "ngrok" : "cloudflare")));
    }
    if (method === "DELETE") { const s = doorStatus() as any; closeDoor(); if (s.agent && url.searchParams.get("revoke")) revokeKey(s.agent); return json({ open: false }); }
  }

  // Opening Dak on the phone: Settings starts the tunnel and shows the link as a code to scan.
  if (parts[0] === "phone") {
    if (method === "GET") return json(phoneStatus());
    if (method === "POST") return json(await openPhone(loadConfig().port));
    if (method === "DELETE") { closePhone(q.get("signout") === "1"); return json(phoneStatus()); }
  }

  if (parts[0] === "agents" && method === "GET") return json(agents({ scan: q.get("scan") === "1" }));

  if (parts[0] === "summary" && method === "GET") {
    const reader = q.get("for") ?? person(loadConfig());
    const list = listThreads(reader, { box: "all" });
    const waiting = list.filter((t) => t.unread > 0);
    // wakes: background turns Dak started on closed sessions, so the Mac app can say so.
    return json({ latest_id: latestMessageId(), unread: waiting.length, wakes: recentWakes(10),
      threads: waiting.slice(0, 10).map((t) => ({ id: t.id, subject: t.subject, from: t.last_author || t.from, kind: t.kind, preview: t.last_body.slice(0, 140) })) });
  }

  if (parts[0] === "blobs" && parts[1] && method === "GET") {
    const file = Bun.file(blobPath(parts[1]));
    const type = q.get("type") || "application/octet-stream";
    return new Response(file, { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" } });
  }

  // Code hopping: where a name is defined and used, and a few lines of any file, for a PR.
  if (parts[0] === "lookup" && method === "GET") {
    const t = q.get("thread") ?? "", att = q.get("att") ?? "";
    if (q.get("file")) return json(await snippet(t, att, q.get("file")!, Number(q.get("line") ?? 1)));
    return json(await lookup(t, att, q.get("name") ?? ""));
  }

  if (parts[0] === "explain" && method === "POST") {
    const b = await body();
    for (const k of ["thread_id", "attachment_id", "file", "start_line"]) if (b[k] === undefined) throw new DakError("bad_request", `Explain needs ${k}.`);
    return json(await explain({ thread_id: b.thread_id, attachment_id: b.attachment_id, file: b.file, side: b.side === "old" ? "old" : "new",
      start_line: Number(b.start_line), end_line: Number(b.end_line ?? b.start_line), question: b.question }));
  }

  if (parts[0] === "events" && method === "GET") {
    // Other processes (the CLI) write the same file, so the server watches the
    // newest message id rather than relying on its own writes.
    // The merge queue changes without a message, so its stamp counts too.
    const stamp = () => `${latestMessageId()}|${queueStamp()}`;
    let last = stamp();
    let timer: ReturnType<typeof setInterval>;
    const stream = new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder();
        ctrl.enqueue(enc.encode(`event: hello\ndata: ${last}\n\n`));
        timer = setInterval(() => {
          try {
            const id = stamp();
            if (id !== last) { last = id; ctrl.enqueue(enc.encode(`event: message\ndata: ${id}\n\n`)); }
            else ctrl.enqueue(enc.encode(`: keep-alive\n\n`));
          } catch { clearInterval(timer); }
        }, 800);
      },
      cancel() { clearInterval(timer); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
  }

  throw new DakError("not_found", `No route ${method} ${url.pathname}.`, 404);
}

function withInstructions(s: any) {
  if (!s.open || !s.url) return s;
  return { ...s, instructions: instructionsFor(s.agent, s.url, agentKey(s.agent), person(loadConfig())) };
}

function dakBinary(): string {
  // Compiled: this very binary. From source: the dak on PATH.
  return process.execPath.endsWith("/bun") ? "dak" : process.execPath;
}

/* Settings is read on every page load, so it must not block the server on child processes:
   Bun (1.1.42) has crashed in spawnSync while a page was loading. Finding a program is a
   look along PATH; the GitHub login is fetched in the background and cached. */
function which(bin: string): boolean {
  const dirs = `${process.env.PATH}:${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin`.split(":");
  return dirs.some((d) => { try { return !!d && statSync(join(d, bin)).isFile(); } catch { return false; } });
}

let ghCache: { at: number; login: string | null } | null = null;
let ghLoading = false;
function ghLogin(): string | null {
  if ((!ghCache || Date.now() - ghCache.at > 60_000) && !ghLoading) {
    ghLoading = true;
    (async () => {
      try {
        const p = Bun.spawn(["gh", "api", "user", "--jq", ".login"], { stdout: "pipe", stderr: "ignore" });
        const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
        ghCache = { at: Date.now(), login: code === 0 ? out.trim() : null };
      } catch { ghCache = { at: Date.now(), login: null }; }
      finally { ghLoading = false; }
    })();
  }
  return ghCache?.login ?? null;
}

function settings() {
  const c = loadConfig();
  return {
    me: person(c),
    readers: c.readers,
    helper: c.helper,
    command: c.explain.command,
    models: c.models,
    helpers: Object.entries(HELPERS).map(([id, h]) => ({ id, label: h.label, installed: which(h.command[0]) })),
    claude_connected: connected("claude"),
    codex_connected: connected("codex"),
    cursor_connected: connected("cursor"),
    codex_listen: !!c.codex_listen,
    wake_closed: c.wake_closed !== false,
    default_models: { codex: codexDefaultModel() },
    github_login: ghLogin(),
    instructions: INSTRUCTIONS, // what Settings offers to copy into Cursor's rules, or any other agent
  };
}

// Over HTTP a doc or file arrives inline: { type: "doc", name, content } or
// { type: "file", name, base64, mime }. Links are { type: "link", url }.
function httpAttachments(list: any): NewAttachment[] {
  if (!Array.isArray(list)) return [];
  return list.map((a: any) => {
    if (a?.type === "doc") return { type: "doc", name: String(a.name ?? "doc.md"), meta: { blob: putBlob(String(a.content ?? "")), version: Number(a.version ?? 1) } };
    if (a?.type === "file") {
      const bytes = Buffer.from(String(a.base64 ?? ""), "base64");
      return { type: "file", name: String(a.name ?? "file"), meta: { blob: putBlob(bytes), size: bytes.length, mime: String(a.mime ?? "application/octet-stream") } };
    }
    if (a?.type === "link") return { type: "link", name: String(a.name ?? a.url), meta: { url: String(a.url) } };
    throw new DakError("bad_attachment", "An attachment is a doc, a file or a link. PRs are sent with the CLI, which can read the repo.");
  }) as NewAttachment[];
}

const optionsOf = (b: any): string[] | undefined => (Array.isArray(b?.options) ? b.options.map(String) : undefined);

// A choice must be one of the buttons offered on this thread, so the sender can match it exactly.
function choiceOn(threadId: string, choice: string): string {
  const offered = getThread(threadId).messages.flatMap((m) => m.options ?? []);
  if (!offered.includes(choice)) throw new DakError("bad_choice", `"${choice}" is not one of the options on this thread.`);
  return choice;
}

// participants: ["codex:reviewer", "pratik:approver"] or [{ name, role }]
function participantsOf(b: any): Participant[] {
  if (!Array.isArray(b?.participants)) return [];
  return b.participants.map((p: any) => typeof p === "string" ? parseParticipant(p) : parseParticipant(`${p?.name ?? ""}:${p?.role ?? "watcher"}`));
}
// cost: { estimate: 0.15, cap: 0.25 }
function costOf(b: any) {
  return b?.cost ? buildCost({ cost: String(b.cost.estimate), ...(b.cost.cap !== undefined ? { cap: String(b.cost.cap) } : {}) }) : undefined;
}

// What a remote agent says about its ask, the same fields the CLI takes: its type (pr, brief,
// decision), what the answer blocks, and its priority (tier and reason).
function askedAs(threadId: string, agent: string, b: any) {
  if (b.type !== undefined || b.blocks !== undefined) describeReview(threadId, { type: b.type === undefined ? undefined : String(b.type), blocks: b.blocks === undefined ? undefined : String(b.blocks) });
  if (b.tier !== undefined || b.why !== undefined) prioritizeReview(threadId, agent, { tier: tierOf(b.tier === undefined ? undefined : String(b.tier)), why: b.why === undefined ? undefined : String(b.why) });
}

/* Bots that speak through one outside key, each with its own name. The first key to use a
   name keeps it, so one key's bots cannot take another's. */
function botsTable() { store().exec("CREATE TABLE IF NOT EXISTS door_bots (name TEXT PRIMARY KEY, agent TEXT NOT NULL, at TEXT NOT NULL)"); }
function botsOf(agent: string): string[] {
  botsTable();
  return (store().query("SELECT name FROM door_bots WHERE agent = ?").all(agent) as { name: string }[]).map((r) => r.name);
}
function claimBot(name: string, agent: string): boolean {
  botsTable();
  const cur = store().query("SELECT agent FROM door_bots WHERE name = ?").get(name) as { agent: string } | null;
  if (cur) return cur.agent === agent;
  // A name some session on this Mac already goes by is not free either.
  if (store().query("SELECT 1 FROM presence WHERE name = ? AND coalesce(tool, '') NOT IN ('grok', 'http')").get(name)) return false;
  store().query("INSERT INTO door_bots (name, agent, at) VALUES (?, ?, ?)").run(name, agent, new Date().toISOString());
  return true;
}
