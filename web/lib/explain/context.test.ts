import { describe, expect, it } from "vitest";
import { BODY_CAP, describeTurn } from "./context";

describe("describeTurn", () => {
  it("is empty without context", () => {
    expect(describeTurn(undefined)).toBe("");
    expect(describeTurn({})).toBe("");
  });

  it("names the branch and its base after a blank line", () => {
    expect(describeTurn({ base: "main", head: "feat/auth" })).toBe(
      "\n\ncontext:\nbranch feat/auth into main"
    );
    expect(describeTurn({ head: "feat/auth" })).toBe("\n\ncontext:\nbranch feat/auth");
    expect(describeTurn({ base: "main" })).toBe("\n\ncontext:\ninto main");
  });

  it("relays an existing pr's title and body", () => {
    expect(
      describeTurn({
        base: "main",
        head: "feat/auth",
        pr: { num: 42, title: "Auth: jwt sessions", body: "  moves sessions to jwt\n" },
      })
    ).toBe(
      "\n\ncontext:\nbranch feat/auth into main\npr #42: Auth: jwt sessions\ncurrent description:\nmoves sessions to jwt"
    );
    // an empty body leaves the description line out
    expect(describeTurn({ pr: { num: 7, title: "t", body: " " } })).toBe("\n\ncontext:\npr #7: t");
  });

  it("cuts a long body at the cap", () => {
    const body = "x".repeat(BODY_CAP + 50);
    const out = describeTurn({ pr: { num: 1, title: "t", body } });
    expect(out.endsWith("x".repeat(BODY_CAP))).toBe(true);
    expect(out).not.toContain("x".repeat(BODY_CAP + 1));
  });
});
