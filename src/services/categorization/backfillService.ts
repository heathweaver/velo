import { getUncategorizedInboxThreadIds, setThreadCategory } from "@/services/db/threadCategories";
import { useCategoryStore, getDefaultCategoryId } from "@/stores/categoryStore";
import { getThreadLabelIds } from "@/services/db/threads";
import { getMessagesForThread } from "@/services/db/messages";
import { categorizeByRules } from "./ruleEngine";

/**
 * Backfill uncategorized inbox threads with rule-based categorization.
 *
 * 1. Query inbox threads that have no entry in thread_categories
 * 2. For each, get labels and last message to run rule engine
 * 3. Insert the resulting category
 * 4. Return count of categorized threads
 */
export async function backfillUncategorizedThreads(
  accountId: string,
  batchSize = 50,
): Promise<number> {
  let totalCategorized = 0;
  let batch: Awaited<ReturnType<typeof getUncategorizedInboxThreadIds>>;

  const knownCategoryIds = new Set(
    useCategoryStore.getState().categories.filter((c) => c.isEnabled).map((c) => c.id),
  );
  const defaultCategoryId = getDefaultCategoryId();

  do {
    batch = await getUncategorizedInboxThreadIds(accountId, batchSize);

    await Promise.all(batch.map(async (thread) => {
      const [labelIds, messages] = await Promise.all([
        getThreadLabelIds(accountId, thread.id),
        getMessagesForThread(accountId, thread.id),
      ]);
      const lastMessage = messages[messages.length - 1];

      const category =
        categorizeByRules({
          labelIds,
          fromAddress: lastMessage?.from_address ?? thread.fromAddress ?? null,
          listUnsubscribe: lastMessage?.list_unsubscribe ?? null,
          knownCategoryIds,
        }) ?? defaultCategoryId;

      await setThreadCategory(accountId, thread.id, category, false);
      totalCategorized++;
    }));
  } while (batch.length === batchSize);

  return totalCategorized;
}
