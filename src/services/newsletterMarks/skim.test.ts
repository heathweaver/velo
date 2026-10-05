import { describe, it, expect } from "vitest";
import { skimNewsletterHeuristic } from "./skim";

describe("skimNewsletterHeuristic", () => {
  it("extracts markdown headings as highlights", () => {
    const result = skimNewsletterHeuristic({
      subject: "Weekly Digest",
      bodyText: "# Big Launch\n\nSome prose.\n\n## Hiring Update\n\nMore prose.",
      topN: 5,
    });
    expect(result.highlights.length).toBeGreaterThanOrEqual(2);
    expect(result.highlights[0]!.title).toContain("Big Launch");
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("falls back to snippet when body is empty", () => {
    const result = skimNewsletterHeuristic({
      subject: "Hello",
      snippet: "Just a short preview of the issue.",
    });
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0]!.quote).toContain("short preview");
  });

  it("boosts score from preference", () => {
    const base = skimNewsletterHeuristic({ subject: "X", snippet: "y".repeat(40) });
    const boosted = skimNewsletterHeuristic({
      subject: "X",
      snippet: "y".repeat(40),
      preferenceScore: 4,
    });
    expect(boosted.score).toBeGreaterThanOrEqual(base.score);
  });
});
