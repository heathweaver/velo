import { describe, it, expect } from "vitest";
import { needsFullRescan } from "./syncWindow";

describe("needsFullRescan", () => {
  // Widening the window cannot be honoured by asking for new UIDs: the mail
  // that is missing is *older* than the folder's high-water mark, and delta
  // sync only ever looks above it. This decides which folders must be walked
  // from the start instead.
  it("rescans when the window widens", () => {
    expect(needsFullRescan(30, 90)).toBe(true);
    expect(needsFullRescan(90, 365)).toBe(true);
  });

  it("rescans everything when the window becomes unlimited", () => {
    // 0 means "all mail", which reaches further back than any finite window.
    expect(needsFullRescan(365, 0)).toBe(true);
    expect(needsFullRescan(30, 0)).toBe(true);
  });

  it("does not rescan when the window is unchanged", () => {
    expect(needsFullRescan(30, 30)).toBe(false);
    expect(needsFullRescan(0, 0)).toBe(false);
  });

  it("does not rescan when the window narrows", () => {
    // Mail already stored stays stored; there is nothing new to fetch.
    expect(needsFullRescan(365, 30)).toBe(false);
    expect(needsFullRescan(0, 30)).toBe(false);
  });

  it("rescans a folder synced before the window was recorded", () => {
    // Exactly the state that produced the bug: folders walked under a 30-day
    // window with no record of it, hiding everything older behind last_uid.
    expect(needsFullRescan(null, 30)).toBe(true);
    expect(needsFullRescan(undefined, 0)).toBe(true);
  });
});
