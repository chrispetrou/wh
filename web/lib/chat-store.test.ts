import { describe, expect, it } from "vitest";
import { chatStore, type ChatLine } from "./chat-store";

// the store is a module singleton: every test uses its own key

const line = (text: string): ChatLine => ({ text, cls: "" });
const many = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => line(`${tag}${i}`));

describe("chat-store line ids", () => {
  it("stamps a monotonic id on push and keeps it across later pushes", () => {
    const key = "ids/basic";
    chatStore.push(key, [line("a"), line("b")]);
    const [a, b] = chatStore.lines(key);
    expect(typeof a.id).toBe("number");
    expect(b.id!).toBeGreaterThan(a.id!);
    chatStore.push(key, [line("c")]);
    const after = chatStore.lines(key);
    expect(after[0].id).toBe(a.id);
    expect(after[1].id).toBe(b.id);
    expect(after[2].id!).toBeGreaterThan(b.id!);
  });

  it("keeps surviving ids when the 200-line cap cuts the top", () => {
    const key = "ids/cap";
    chatStore.push(key, many(200, "x"));
    const before = chatStore.lines(key);
    const keptIds = before.slice(10).map((l) => l.id);
    chatStore.push(key, many(10, "y"));
    const after = chatStore.lines(key);
    expect(after).toHaveLength(200);
    expect(after.slice(0, 190).map((l) => l.id)).toEqual(keptIds);
    // every id still unique
    expect(new Set(after.map((l) => l.id)).size).toBe(200);
  });

  it("shifts live, draft, and expanded with the cut", () => {
    const key = "ids/shift";
    chatStore.push(key, many(200, "x"));
    chatStore.setLive(key, { line: 150, selected: 1 });
    chatStore.setDraft(key, { line: 150, base: "b", sha: "s" });
    chatStore.setExpanded(key, 150, ["abc"]);
    chatStore.push(key, many(10, "y"));
    expect(chatStore.live(key)).toEqual({ line: 140, selected: 1 });
    expect(chatStore.draft(key)).toEqual({ line: 140, base: "b", sha: "s" });
    expect(chatStore.expanded(key, 140)).toEqual(["abc"]);
    expect(chatStore.expanded(key, 150)).toEqual([]);
  });

  it("drops live and draft when their line is cut", () => {
    const key = "ids/drop";
    chatStore.push(key, many(200, "x"));
    chatStore.setLive(key, { line: 3, selected: null });
    chatStore.setDraft(key, { line: 3, base: "b", sha: "s" });
    chatStore.push(key, many(10, "y"));
    expect(chatStore.live(key)).toBeUndefined();
    expect(chatStore.draft(key)).toBeUndefined();
  });

  it("setAll stamps missing ids and keeps existing ones", () => {
    const key = "ids/setall";
    chatStore.push(key, [line("a"), line("b")]);
    const [a] = chatStore.lines(key);
    chatStore.setAll(key, [chatStore.lines(key)[0], line("new")]);
    const after = chatStore.lines(key);
    expect(after[0].id).toBe(a.id);
    expect(typeof after[1].id).toBe("number");
    expect(after[1].id!).toBeGreaterThan(a.id!);
  });

  it("setBlock keeps the line id", () => {
    const key = "ids/setblock";
    chatStore.push(key, [
      { text: "", cls: "", block: { kind: "branches", rows: [] } as never },
    ]);
    const id = chatStore.lines(key)[0].id;
    chatStore.setBlock(key, 0, { kind: "branches", rows: [{ n: 1 }] } as never);
    expect(chatStore.lines(key)[0].id).toBe(id);
  });
});
