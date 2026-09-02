import { afterEach, describe, expect, it, vi } from "vitest";
import { secureCookies } from "./origin";

afterEach(() => vi.unstubAllEnvs());

describe("secureCookies", () => {
  it("follows the APP_URL scheme when set", () => {
    vi.stubEnv("APP_URL", "https://wd.example.com");
    expect(secureCookies()).toBe(true);
    vi.stubEnv("APP_URL", "http://192.168.1.10:3000");
    expect(secureCookies()).toBe(false);
  });

  it("an https APP_URL wins even outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_URL", "https://wd.example.com");
    expect(secureCookies()).toBe(true);
  });

  it("falls back to NODE_ENV without an APP_URL", () => {
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("NODE_ENV", "production");
    expect(secureCookies()).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(secureCookies()).toBe(false);
  });

  it("treats an unparseable APP_URL as unset", () => {
    vi.stubEnv("APP_URL", "not a url");
    vi.stubEnv("NODE_ENV", "production");
    expect(secureCookies()).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(secureCookies()).toBe(false);
  });
});
