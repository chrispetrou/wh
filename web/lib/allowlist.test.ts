import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedLogins, loginAllowed } from "./allowlist";

afterEach(() => vi.unstubAllEnvs());

describe("allowedLogins", () => {
  it("is open when unset or empty", () => {
    vi.stubEnv("WH_ALLOWED_LOGINS", undefined);
    expect(allowedLogins()).toBeNull();
    vi.stubEnv("WH_ALLOWED_LOGINS", "");
    expect(allowedLogins()).toBeNull();
    vi.stubEnv("WH_ALLOWED_LOGINS", " , ,");
    expect(allowedLogins()).toBeNull();
  });

  it("parses commas, whitespace, and case", () => {
    vi.stubEnv("WH_ALLOWED_LOGINS", " Alice, bob ,,carol-dev ");
    expect(allowedLogins()).toEqual(new Set(["alice", "bob", "carol-dev"]));
  });

  it("is read per call, not cached", () => {
    vi.stubEnv("WH_ALLOWED_LOGINS", "alice");
    expect(loginAllowed("bob")).toBe(false);
    vi.stubEnv("WH_ALLOWED_LOGINS", "alice,bob");
    expect(loginAllowed("bob")).toBe(true);
  });
});

describe("loginAllowed", () => {
  it("lets anyone in when no list is set", () => {
    vi.stubEnv("WH_ALLOWED_LOGINS", undefined);
    expect(loginAllowed("anyone")).toBe(true);
    expect(loginAllowed(undefined)).toBe(true);
  });

  it("matches case-insensitively in both directions", () => {
    vi.stubEnv("WH_ALLOWED_LOGINS", "Alice");
    expect(loginAllowed("alice")).toBe(true);
    expect(loginAllowed("ALICE")).toBe(true);
    vi.stubEnv("WH_ALLOWED_LOGINS", "bob");
    expect(loginAllowed("Bob")).toBe(true);
  });

  it("denies a missing or empty login when a list is active", () => {
    vi.stubEnv("WH_ALLOWED_LOGINS", "alice");
    expect(loginAllowed(undefined)).toBe(false);
    expect(loginAllowed("")).toBe(false);
    expect(loginAllowed("mallory")).toBe(false);
  });
});
