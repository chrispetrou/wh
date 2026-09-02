import { describe, expect, it } from "vitest";
import { suggest } from "./suggest";

describe("suggest", () => {
  const history = ["log 10 on main", "explain 3", "log 5", "explain the last 4 commits"];

  it("completes from the most recent matching entry", () => {
    expect(suggest("log", history)).toBe(" 10 on main");
    expect(suggest("explain t", history)).toBe("he last 4 commits");
  });

  it("returns nothing for an empty or blank input", () => {
    expect(suggest("", history)).toBe("");
    expect(suggest("   ", history)).toBe("");
  });

  it("returns nothing when the input is already a full entry", () => {
    expect(suggest("explain 3", history)).toBe("");
  });

  it("still extends an exact entry when an older one is longer", () => {
    expect(suggest("log 5", ["log 5", "log 5 on dev"])).toBe(" on dev");
  });

  it("returns nothing without a match", () => {
    expect(suggest("diff", history)).toBe("");
    expect(suggest("log", [])).toBe("");
  });

  it("matches case-sensitively, like a shell", () => {
    expect(suggest("LOG", history)).toBe("");
  });
});
