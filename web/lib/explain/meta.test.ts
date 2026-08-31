import { describe, expect, it } from "vitest";
import { parseMeta } from "./meta";

describe("parseMeta", () => {
  it("parses the meta object of a well-formed first line", () => {
    expect(parseMeta('{"commits":2,"files":1}')).toEqual({ commits: 2, files: 1 });
    expect(parseMeta('{"branches":true}')).toEqual({ branches: true });
    expect(parseMeta("{}")).toEqual({});
  });

  it("returns null for anything that is not our json object", () => {
    expect(parseMeta("")).toBeNull();
    expect(parseMeta("<html><body>502 bad gateway</body></html>")).toBeNull();
    expect(parseMeta('{"commits":2')).toBeNull(); // truncated
    expect(parseMeta("[1,2]")).toBeNull();
    expect(parseMeta('"a string"')).toBeNull();
    expect(parseMeta("null")).toBeNull();
    expect(parseMeta("42")).toBeNull();
  });
});
