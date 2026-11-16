import { expect, test } from "bun:test";
import { blocks } from "../ui/md";

// What a comment quotes is what the reader saw: plain words, no Markdown markers,
// and each top-level block is one place a comment can hang.
test("blocks split at top level and quote plain words", () => {
  const b = blocks("# Title\n\nA **bold** move with `code` and [a link](https://x.y).\n\n- one\n- two\n");
  expect(b.map((x) => x.text)).toEqual(["Title", "A bold move with code and a link.", "one two"]);
  expect(new Set(b.map((x) => x.hash)).size).toBe(3);
});

test("an unchanged block keeps its hash in the next version", () => {
  const v1 = blocks("Intro.\n\nKept paragraph.\n");
  const v2 = blocks("New intro, longer.\n\nKept paragraph.\n");
  expect(v2[1].hash).toBe(v1[1].hash);
  expect(v2[0].hash).not.toBe(v1[0].hash);
});
