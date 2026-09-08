/**
 * Maps what the sidebar shows to what the thread list must load.
 *
 * Kept pure so tests can assert view → query without mounting EmailList.
 * EmailList must call resolveThreadListQuery — do not duplicate LABEL_MAP there.
 */

import { ALL_INBOXES_LABEL } from "@/constants/unifiedInbox";

/** Sidebar system-folder ids → Gmail-style label ids used in thread_labels. */
export const SYSTEM_LABEL_MAP: Record<string, string> = {
  inbox: "INBOX",
  starred: "STARRED",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  snoozed: "SNOOZED",
  /** Empty string means no label filter (All Mail). */
  all: "",
};

export type ThreadListQuery =
  | {
      type: "smart";
      /** Search/smart-folder query string. */
      query: string;
      /** Omit to search every account (All Inboxes / search-all smart folders). */
      accountId: string | undefined;
    }
  | {
      type: "category";
      accountId: string;
      category: string;
    }
  | {
      type: "label";
      accountId: string;
      /** Undefined = All Mail (no label filter). */
      labelId: string | undefined;
    };

export interface ResolveThreadListQueryInput {
  activeAccountId: string | null;
  activeLabel: string;
  /** Split-inbox category, or "All" when unified / not inbox. */
  activeCategory: string;
  smartFolderQuery: string | null;
  smartFolderSearchAllAccounts: boolean;
}

/**
 * Decide which DB path EmailList must use for the current sidebar selection.
 * Returns null when there is no account and the view needs one.
 */
export function resolveThreadListQuery(
  input: ResolveThreadListQueryInput,
): ThreadListQuery | null {
  const {
    activeAccountId,
    activeLabel,
    activeCategory,
    smartFolderQuery,
    smartFolderSearchAllAccounts,
  } = input;

  const isAllInboxes = activeLabel === ALL_INBOXES_LABEL;
  const isSmartFolder = activeLabel.startsWith("smart-folder:");

  if (isAllInboxes) {
    return { type: "smart", query: "label:inbox", accountId: undefined };
  }

  if (isSmartFolder && smartFolderQuery !== null) {
    return {
      type: "smart",
      query: smartFolderQuery,
      accountId: smartFolderSearchAllAccounts ? undefined : (activeAccountId ?? undefined),
    };
  }

  if (!activeAccountId) return null;

  if (activeLabel === "inbox" && activeCategory !== "All") {
    return { type: "category", accountId: activeAccountId, category: activeCategory };
  }

  if (activeLabel in SYSTEM_LABEL_MAP) {
    const mapped = SYSTEM_LABEL_MAP[activeLabel]!;
    return {
      type: "label",
      accountId: activeAccountId,
      labelId: mapped === "" ? undefined : mapped,
    };
  }

  // Custom user label id from /label/$labelId
  return { type: "label", accountId: activeAccountId, labelId: activeLabel };
}

/** Sidebar system views that load a single Gmail-style label (or All Mail). */
export const SYSTEM_SIDEBAR_VIEWS = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "trash",
  "spam",
  "all",
] as const;

export type SystemSidebarView = (typeof SYSTEM_SIDEBAR_VIEWS)[number];
