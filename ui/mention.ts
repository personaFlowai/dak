/* @mentions while writing: typing "@" in a reply box lists the team, and Enter, Tab or a click
   puts the @name in. In messages, a mention is shown as one. */
import { S, esc } from "./state";

const BOXES = new Set(["message", "c-body", "edit"]);
let pop: { box: HTMLTextAreaElement; start: number; items: string[]; i: number } | null = null;

const names = (): { name: string; label: string }[] =>
  (S.team ?? []).map((m: any) => ({ name: m.name as string, label: [m.display, m.role].filter(Boolean).join(" · ") }));

function close() { pop = null; document.getElementById("mention-pop")?.remove(); }

function show() {
  if (!pop) return;
  let el = document.getElementById("mention-pop");
  if (!el) { el = document.createElement("div"); el.id = "mention-pop"; el.setAttribute("role", "listbox"); document.body.appendChild(el); }
  const all = names();
  el.innerHTML = pop.items.map((n, i) => {
    const label = all.find((x) => x.name === n)?.label ?? "";
    return `<button type="button" role="option" aria-selected="${i === pop!.i}" class="${i === pop!.i ? "on" : ""}" data-mention-pick="${esc(n)}"><b>@${esc(n)}</b>${label ? `<span>${esc(label)}</span>` : ""}</button>`;
  }).join("");
  const r = pop.box.getBoundingClientRect();
  // Under the box when there is room, else above it.
  const h = Math.min(260, pop.items.length * 40 + 8);
  el.style.left = `${Math.max(8, r.left)}px`;
  el.style.width = `${Math.min(340, r.width)}px`;
  el.style.top = `${r.bottom + h + 8 < innerHeight ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
}

function pick(name: string) {
  if (!pop) return;
  const { box, start } = pop;
  const end = box.selectionStart ?? box.value.length;
  box.value = `${box.value.slice(0, start)}@${name} ${box.value.slice(end)}`;
  const at = start + name.length + 2;
  box.setSelectionRange(at, at);
  box.dispatchEvent(new Event("input", { bubbles: true })); // the draft is kept as typed
  close();
  box.focus();
}

document.addEventListener("input", (e) => {
  const box = e.target as HTMLTextAreaElement;
  if (!BOXES.has(box?.id) || box.tagName !== "TEXTAREA") return;
  const before = box.value.slice(0, box.selectionStart ?? 0);
  const m = before.match(/(?:^|[\s(])@([a-z0-9_-]{0,40})$/i);
  if (!m) return close();
  const q = m[1].toLowerCase();
  const items = names().map((x) => x.name).filter((n) => n.includes(q)).sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q))).slice(0, 6);
  if (!items.length) return close();
  pop = { box, start: before.length - m[1].length - 1, items, i: 0 };
  show();
});

// Runs before the app's own keys, so Enter picks a name instead of sending.
document.addEventListener("keydown", (e) => {
  if (!pop || e.target !== pop.box) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { pop.i = (pop.i + (e.key === "ArrowDown" ? 1 : pop.items.length - 1)) % pop.items.length; show(); }
  else if (e.key === "Enter" || e.key === "Tab") pick(pop.items[pop.i]);
  else if (e.key === "Escape") close();
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);

document.addEventListener("mousedown", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-mention-pick]");
  if (b) { e.preventDefault(); pick(b.dataset.mentionPick!); }
  else if (pop && !(e.target as HTMLElement).closest("#mention-pop")) close();
}, true);
document.addEventListener("focusout", (e) => { if (pop && e.target === pop.box) setTimeout(() => { if (document.activeElement !== pop?.box) close(); }, 0); });

// In a rendered message: "@lead" for each name the message mentions, shown as a mention.
export function markMentions(html: string, mentions?: string[]): string {
  if (!mentions?.length) return html;
  return mentions.reduce((h, n) => h.replace(new RegExp(`(^|[\\s(>])@(${n.replace(/[-]/g, "\\-")})(?![\\w-])`, "g"), `$1<span class="mention">@$2</span>`), html);
}
