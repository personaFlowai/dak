/* Who a message is for. Only the reader a message is for is woken by it and gets it in full;
   everyone else on the topic gets one line at their next turn. Most of what agents spent on Dak
   was reading mail that was about someone else.

   - A message that @mentions someone is for the members it mentions, and no one else.
   - A mentioned member's reply is for whoever mentioned it.
   - In a group, @all is for every member, and so is the person's message with no @mention: when
     the person writes to a group they mean the group. An agent's message with no @mention is for
     no one; each member reads it at their next turn. Agents talking among themselves is where
     most of the reading went.
   - Otherwise it is for the topic's other end, and anyone added to review, approve or watch it. */
import { getThreadRow, participantsOf } from "./store";
import { loadConfig, person } from "./config";
import type { Message } from "./types";

export function isFor(m: Message, reader: string): boolean {
  if (m.author === reader) return false;
  if (m.everyone) return true;
  if (m.mentions?.length) return m.mentions.includes(reader);
  if (m.answers) return m.answers === reader;
  const t = getThreadRow(m.thread_id);
  if (t.to.startsWith("group:")) return m.author === person(loadConfig());
  if (reader === t.to || reader === t.from) return true;
  return participantsOf(m.thread_id).some((p) => p.name === reader && p.role !== "member");
}
