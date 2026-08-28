import { describe, it, expect } from "vitest";
import { buildDateQuery, parseSyncPeriodDays, windowReach } from "./syncWindow";

describe("syncWindow", () => {
  it("parseSyncPeriodDays treats 0 as all mail", () => {
    expect(parseSyncPeriodDays("0")).toBe(0);
    expect(parseSyncPeriodDays(null)).toBe(30);
    expect(parseSyncPeriodDays("365")).toBe(365);
    expect(parseSyncPeriodDays("nope")).toBe(30);
  });

  it("buildDateQuery returns undefined for unlimited window", () => {
    expect(buildDateQuery(0)).toBeUndefined();
    expect(buildDateQuery(-1)).toBeUndefined();
  });

  it("buildDateQuery returns after: query for finite windows", () => {
    expect(buildDateQuery(30)).toMatch(/^after:\d+\/\d+\/\d+$/);
  });

  it("windowReach ranks unlimited above finite windows", () => {
    expect(windowReach(0)).toBeGreaterThan(windowReach(30));
    expect(windowReach(365)).toBe(365);
  });
});
