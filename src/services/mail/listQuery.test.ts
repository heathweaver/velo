import { describe, it, expect } from "vitest";
import {
  resolveThreadListQuery,
  SYSTEM_LABEL_MAP,
  SYSTEM_SIDEBAR_VIEWS,
} from "./listQuery";
import { ALL_INBOXES_LABEL } from "@/constants/unifiedInbox";

const ACCOUNT = "acc-1";

/** Soft budget: resolving a view must stay trivial (no I/O). */
const RESOLVE_BUDGET_MS = 5;

describe("SYSTEM_SIDEBAR_VIEWS → label filter", () => {
  it.each([
    ["inbox", "INBOX"],
    ["starred", "STARRED"],
    ["snoozed", "SNOOZED"],
    ["sent", "SENT"],
    ["drafts", "DRAFT"],
    ["trash", "TRASH"],
    ["spam", "SPAM"],
  ] as const)("%s loads only threads with label %s", (view, labelId) => {
    const started = performance.now();
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: view,
      activeCategory: "All",
      smartFolderQuery: null,
      smartFolderSearchAllAccounts: false,
    });
    const elapsed = performance.now() - started;

    expect(q).toEqual({ type: "label", accountId: ACCOUNT, labelId });
    expect(elapsed).toBeLessThan(RESOLVE_BUDGET_MS);
  });

  it("all (All Mail) loads with no label filter", () => {
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: "all",
      activeCategory: "All",
      smartFolderQuery: null,
      smartFolderSearchAllAccounts: false,
    });
    expect(q).toEqual({ type: "label", accountId: ACCOUNT, labelId: undefined });
  });

  it("every system sidebar view is covered by SYSTEM_LABEL_MAP", () => {
    for (const view of SYSTEM_SIDEBAR_VIEWS) {
      expect(SYSTEM_LABEL_MAP[view]).toBeDefined();
    }
  });
});

describe("inbox category tabs", () => {
  it("Primary (and other categories) use category query, not raw INBOX list", () => {
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: "inbox",
      activeCategory: "Primary",
      smartFolderQuery: null,
      smartFolderSearchAllAccounts: false,
    });
    expect(q).toEqual({ type: "category", accountId: ACCOUNT, category: "Primary" });
  });

  it("Inbox + All uses INBOX label list", () => {
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: "inbox",
      activeCategory: "All",
      smartFolderQuery: null,
      smartFolderSearchAllAccounts: false,
    });
    expect(q).toEqual({ type: "label", accountId: ACCOUNT, labelId: "INBOX" });
  });
});

describe("All Inboxes / smart folders", () => {
  it("All Inboxes searches label:inbox across every account", () => {
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: ALL_INBOXES_LABEL,
      activeCategory: "All",
      smartFolderQuery: null,
      smartFolderSearchAllAccounts: false,
    });
    expect(q).toEqual({ type: "smart", query: "label:inbox", accountId: undefined });
  });

  it("smart folder scopes to the active account by default", () => {
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: "smart-folder:sf-1",
      activeCategory: "All",
      smartFolderQuery: "from:boss@example.com",
      smartFolderSearchAllAccounts: false,
    });
    expect(q).toEqual({
      type: "smart",
      query: "from:boss@example.com",
      accountId: ACCOUNT,
    });
  });

  it("smart folder can search all accounts", () => {
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: "smart-folder:sf-1",
      activeCategory: "All",
      smartFolderQuery: "is:unread",
      smartFolderSearchAllAccounts: true,
    });
    expect(q).toEqual({ type: "smart", query: "is:unread", accountId: undefined });
  });
});

describe("custom labels", () => {
  it("unknown label ids are treated as user label ids", () => {
    const q = resolveThreadListQuery({
      activeAccountId: ACCOUNT,
      activeLabel: "Label_42",
      activeCategory: "All",
      smartFolderQuery: null,
      smartFolderSearchAllAccounts: false,
    });
    expect(q).toEqual({ type: "label", accountId: ACCOUNT, labelId: "Label_42" });
  });

  it("returns null when a per-account view has no account", () => {
    expect(
      resolveThreadListQuery({
        activeAccountId: null,
        activeLabel: "starred",
        activeCategory: "All",
        smartFolderQuery: null,
        smartFolderSearchAllAccounts: false,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadListQuery performance", () => {
  it(`resolves every system view under ${RESOLVE_BUDGET_MS}ms each`, () => {
    for (const view of SYSTEM_SIDEBAR_VIEWS) {
      const started = performance.now();
      resolveThreadListQuery({
        activeAccountId: ACCOUNT,
        activeLabel: view,
        activeCategory: "All",
        smartFolderQuery: null,
        smartFolderSearchAllAccounts: false,
      });
      expect(performance.now() - started).toBeLessThan(RESOLVE_BUDGET_MS);
    }
  });
});
