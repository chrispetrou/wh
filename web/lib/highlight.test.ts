import { describe, expect, it } from "vitest";
import { langFor, splitHighlighted } from "./highlight";

describe("langFor", () => {
  it("maps extensions and special basenames, null for the unknown", () => {
    expect(langFor("src/main.rs")).toBe("rust");
    expect(langFor("web/lib/block.ts")).toBe("typescript");
    expect(langFor("a/b/App.tsx")).toBe("typescript");
    expect(langFor("Makefile")).toBe("makefile");
    expect(langFor("deploy/Dockerfile")).toBe("dockerfile");
    expect(langFor("notes.xyz")).toBeNull();
    expect(langFor("LICENSE")).toBeNull();
    expect(langFor(".gitignore")).toBeNull(); // a leading dot is not an extension
  });
});

describe("splitHighlighted", () => {
  it("passes plain text through line by line", () => {
    expect(splitHighlighted("one\ntwo\nthree")).toEqual(["one", "two", "three"]);
    expect(splitHighlighted("just one")).toEqual(["just one"]);
  });

  it("closes and reopens a span crossing lines", () => {
    const html = 'a <span class="hljs-comment">/* one\ntwo\nthree */</span> b';
    expect(splitHighlighted(html)).toEqual([
      'a <span class="hljs-comment">/* one</span>',
      '<span class="hljs-comment">two</span>',
      '<span class="hljs-comment">three */</span> b',
    ]);
  });

  it("repairs nested spans", () => {
    const html = '<span class="a"><span class="b">x\ny</span>z</span>';
    expect(splitHighlighted(html)).toEqual([
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span>z</span>',
    ]);
  });
});
