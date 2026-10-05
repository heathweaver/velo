import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/db/filters", () => ({
  getFiltersForAccount: vi.fn(),
  insertFilter: vi.fn(),
  updateFilter: vi.fn(),
}));
vi.mock("@/services/db/labels", () => ({
  getLabelsForAccount: vi.fn(),
}));
vi.mock("@/services/db/categories", () => ({
  getAllCategories: vi.fn(),
}));
vi.mock("@/services/db/newsletterPrefs", () => ({
  getNewsletterPref: vi.fn(),
  upsertNewsletterPref: vi.fn(),
}));
vi.mock("@/services/db/messages", () => ({
  getMessagesForThread: vi.fn(),
}));

import { getFiltersForAccount, insertFilter, updateFilter } from "@/services/db/filters";
import { getLabelsForAccount } from "@/services/db/labels";
import { getAllCategories } from "@/services/db/categories";
import { getNewsletterPref, upsertNewsletterPref } from "@/services/db/newsletterPrefs";
import { getMessagesForThread } from "@/services/db/messages";
import { applyNewsletterMark, resolveReadsFiling } from "./marks";

describe("newsletter marks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMessagesForThread).mockResolvedValue([
      {
        id: "m1",
        account_id: "a1",
        thread_id: "t1",
        from_address: "news@example.com",
        from_name: "News",
      } as never,
    ]);
    vi.mocked(getNewsletterPref).mockResolvedValue(null);
    vi.mocked(upsertNewsletterPref).mockResolvedValue("pref-1");
    vi.mocked(getFiltersForAccount).mockResolvedValue([]);
    vi.mocked(insertFilter).mockResolvedValue("filter-1");
    vi.mocked(getLabelsForAccount).mockResolvedValue([]);
    vi.mocked(getAllCategories).mockResolvedValue([
      { id: "Newsletters", name: "Newsletters" } as never,
    ]);
  });

  it("Interesting boosts preference without creating a filter", async () => {
    const result = await applyNewsletterMark("a1", "t1", "interesting");
    expect(result.preferenceScore).toBe(1);
    expect(insertFilter).not.toHaveBeenCalled();
    expect(upsertNewsletterPref).toHaveBeenCalledWith(
      expect.objectContaining({ preferenceScore: 1, stopped: false }),
    );
  });

  it("Noise creates archive+read filter", async () => {
    const result = await applyNewsletterMark("a1", "t1", "noise");
    expect(result.filterRuleId).toBe("filter-1");
    expect(insertFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        criteria: { from: "news@example.com" },
        actions: { archive: true, markRead: true },
      }),
    );
  });

  it("Always Reads uses interim category when no Reads folder", async () => {
    const filing = await resolveReadsFiling("a1");
    expect(filing.actions).toEqual({ setCategory: "Newsletters" });

    await applyNewsletterMark("a1", "t1", "always_reads");
    expect(insertFilter).toHaveBeenCalledWith(
      expect.objectContaining({
        actions: { setCategory: "Newsletters" },
      }),
    );
  });

  it("Always Reads prefers Reads label when present", async () => {
    vi.mocked(getLabelsForAccount).mockResolvedValue([
      { id: "Reads", name: "Reads", account_id: "a1" } as never,
    ]);
    const filing = await resolveReadsFiling("a1");
    expect(filing.actions).toEqual({ applyLabel: "Reads" });
  });

  it("Stop disables matching filters", async () => {
    vi.mocked(getFiltersForAccount).mockResolvedValue([
      {
        id: "f1",
        criteria_json: JSON.stringify({ from: "news@example.com" }),
        actions_json: "{}",
      } as never,
    ]);
    await applyNewsletterMark("a1", "t1", "stop");
    expect(updateFilter).toHaveBeenCalledWith("f1", { isEnabled: false });
    expect(upsertNewsletterPref).toHaveBeenCalledWith(
      expect.objectContaining({ stopped: true }),
    );
  });
});
