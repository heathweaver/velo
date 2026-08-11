import type { FilterCriteria, FilterActions } from "../db/filters";
import { getEnabledFiltersForAccount } from "../db/filters";
import type { ParsedMessage } from "../gmail/messageParser";
import { addThreadLabel, removeThreadLabel, markThreadRead, starThread } from "../emailActions";
import { setThreadCategory } from "../db/threadCategories";

/**
 * Check if a parsed message matches the given filter criteria.
 * All set criteria must match (AND logic). Matching is case-insensitive substring.
 */
export function messageMatchesFilter(
  message: ParsedMessage,
  criteria: FilterCriteria,
): boolean {
  if (criteria.from) {
    const fromStr = `${message.fromName ?? ""} ${message.fromAddress ?? ""}`.toLowerCase();
    if (!fromStr.includes(criteria.from.toLowerCase())) return false;
  }

  if (criteria.to) {
    const toStr = (message.toAddresses ?? "").toLowerCase();
    if (!toStr.includes(criteria.to.toLowerCase())) return false;
  }

  if (criteria.subject) {
    const subjectStr = (message.subject ?? "").toLowerCase();
    if (!subjectStr.includes(criteria.subject.toLowerCase())) return false;
  }

  if (criteria.body) {
    const bodyStr = `${message.bodyText ?? ""} ${message.bodyHtml ?? ""}`.toLowerCase();
    if (!bodyStr.includes(criteria.body.toLowerCase())) return false;
  }

  if (criteria.hasAttachment) {
    if (!message.hasAttachments) return false;
  }

  return true;
}

export interface FilterResult {
  addLabelIds: string[];
  removeLabelIds: string[];
  markRead: boolean;
  star: boolean;
  /** Category id to file the thread under, or null to leave it alone. */
  setCategory: string | null;
}

/**
 * Compute the aggregate label/flag changes from a set of filter actions.
 */
export function computeFilterActions(actions: FilterActions): FilterResult {
  const addLabelIds: string[] = [];
  const removeLabelIds: string[] = [];

  if (actions.applyLabel) {
    addLabelIds.push(actions.applyLabel);
  }

  if (actions.archive) {
    removeLabelIds.push("INBOX");
  }

  if (actions.trash) {
    addLabelIds.push("TRASH");
    removeLabelIds.push("INBOX");
  }

  if (actions.star) {
    addLabelIds.push("STARRED");
  }

  return {
    addLabelIds,
    removeLabelIds,
    markRead: actions.markRead ?? false,
    star: actions.star ?? false,
    setCategory: actions.setCategory ?? null,
  };
}

/**
 * Apply all enabled filters to a set of new messages for the given account.
 * Modifies threads via the Gmail API and updates local DB.
 */
export async function applyFiltersToMessages(
  accountId: string,
  messages: ParsedMessage[],
): Promise<void> {
  const filters = await getEnabledFiltersForAccount(accountId);
  if (filters.length === 0) return;

  // Pre-parse filter JSON once (not per-message) to avoid O(M×F) parse operations
  const parsedFilters = filters.flatMap((filter) => {
    try {
      return [{
        criteria: JSON.parse(filter.criteria_json) as FilterCriteria,
        actions: JSON.parse(filter.actions_json) as FilterActions,
      }];
    } catch {
      return [];
    }
  });
  if (parsedFilters.length === 0) return;

  // Group actions by threadId so we can batch modifications
  const threadActions = new Map<string, FilterResult>();

  for (const msg of messages) {
    for (const { criteria, actions } of parsedFilters) {
      if (messageMatchesFilter(msg, criteria)) {
        const result = computeFilterActions(actions);
        const existing = threadActions.get(msg.threadId);
        if (existing) {
          // Merge results
          existing.addLabelIds.push(...result.addLabelIds);
          existing.removeLabelIds.push(...result.removeLabelIds);
          existing.markRead = existing.markRead || result.markRead;
          existing.star = existing.star || result.star;
          // First filter to name a category wins, matching the label merge
          // above where later filters add to rather than replace the result.
          existing.setCategory = existing.setCategory ?? result.setCategory;
        } else {
          threadActions.set(msg.threadId, result);
        }
      }
    }
  }

  // Apply combined actions per thread in parallel
  await Promise.allSettled(
    [...threadActions].map(async ([threadId, result]) => {
      const addLabels = [...new Set(result.addLabelIds)];
      const removeLabels = [...new Set(result.removeLabelIds)];

      try {
        // Category first: it is local-only, so it still lands even if a
        // server-side label change below fails.
        if (result.setCategory) {
          // Manual, so the classifier does not overwrite it on the next sweep —
          // the user asked for this category by writing the rule.
          await setThreadCategory(accountId, threadId, result.setCategory, true);
        }

        // Apply label changes via provider
        for (const labelId of addLabels) {
          await addThreadLabel(accountId, threadId, labelId);
        }
        for (const labelId of removeLabels) {
          await removeThreadLabel(accountId, threadId, labelId);
        }

        // Mark as read via provider
        if (result.markRead) {
          await markThreadRead(accountId, threadId, [], true);
        }

        // Star via provider
        if (result.star) {
          await starThread(accountId, threadId, [], true);
        }
      } catch (err) {
        console.error(`Failed to apply filter actions to thread ${threadId}:`, err);
      }
    }),
  );
}
