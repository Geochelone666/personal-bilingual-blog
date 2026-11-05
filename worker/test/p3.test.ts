import { describe, it, expect } from "vitest";
import { cleanPath, cleanReferrer, weekKey } from "../src/p3";
import { fixSentenceSpacing } from "../src/util";

describe("p3", () => {
  it("accepts only blog paths", () => {
    expect(cleanPath("/zh/posts/2026-11-05-x/")).toBe("/zh/posts/2026-11-05-x/");
    expect(cleanPath("/en/?utm=1")).toBe("/en/");
    expect(cleanPath("/etc/passwd")).toBeNull();
    expect(cleanPath("https://evil")).toBeNull();
    expect(cleanPath("/zh/<script>/")).toBeNull();
  });
  it("keeps only external referrer hosts", () => {
    expect(cleanReferrer("www.Google.com")).toBe("google.com");
    expect(cleanReferrer("personal-bilingual-blog.pages.dev")).toBe("");
    expect(cleanReferrer("bad host!")).toBe("");
  });
  it("computes ISO weeks", () => {
    expect(weekKey(new Date("2026-11-09T15:00:00Z"))).toBe("2026-W46");
    expect(weekKey(new Date("2027-01-01T15:00:00Z"))).toBe("2026-W53");
  });
  it("fixes run-together sentences", () => {
    expect(fixSentenceSpacing("progress.Technological way.The x.)With")).toBe("progress. Technological way. The x.) With");
    expect(fixSentenceSpacing("3.5 and e.g. fine")).toBe("3.5 and e.g. fine");
  });
});
