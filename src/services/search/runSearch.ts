import { searchMessages } from "@/services/db/search";
import { useThreadStore } from "@/stores/threadStore";

/**
 * Run a search and publish the result to the thread store.
 *
 * The search bar is bound to `searchQuery` in that store, so anything calling
 * this also populates the visible search box — which is the point: a search
 * started from elsewhere in the app should look exactly like one the user
 * typed, and stay editable from there.
 */
export async function runSearch(
  query: string,
  accountId: string | null | undefined,
  limit = 100,
): Promise<void> {
  const { setSearch } = useThreadStore.getState();
  setSearch(query, useThreadStore.getState().searchThreadIds);

  if (query.trim().length < 2) {
    setSearch(query, null);
    return;
  }

  try {
    const hits = await searchMessages(query, accountId ?? undefined, limit);
    useThreadStore.getState().setSearch(query, new Set(hits.map((h) => h.thread_id)));
  } catch {
    // Leave the query in the box so the user can edit it rather than losing
    // what they searched for.
    useThreadStore.getState().setSearch(query, null);
  }
}
