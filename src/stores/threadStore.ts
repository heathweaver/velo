import { create } from "zustand";

export interface Thread {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isPinned: boolean;
  isMuted: boolean;
  hasAttachments: boolean;
  labelIds: string[];
  fromName: string | null;
  fromAddress: string | null;
}

interface ThreadState {
  threads: Thread[];
  threadMap: Map<string, Thread>;
  selectedThreadId: string | null;
  selectedThreadIds: Set<string>;
  isLoading: boolean;
  searchQuery: string;
  searchThreadIds: Set<string> | null; // null = no active search
  /**
   * Threads whose removal (archive/trash/spam/move) is still in flight.
   *
   * The optimistic update hides the thread immediately, but the server call
   * that follows takes time, and a sync completing in that window re-reads the
   * database — where the row may still exist, or may have been re-inserted from
   * a server that has not applied the move yet. The list then shows the thread
   * again until cleanup removes it a second time, which reads as a flicker.
   * Holding the ids here lets reloads skip them until the action settles.
   */
  pendingRemovalIds: Set<string>;
  beginRemoval: (ids: string[]) => void;
  endRemoval: (ids: string[]) => void;
  setThreads: (threads: Thread[]) => void;
  selectThread: (id: string | null) => void;
  toggleThreadSelection: (id: string) => void;
  selectThreadRange: (id: string) => void;
  clearMultiSelect: () => void;
  selectAll: () => void;
  selectAllFromHere: () => void;
  setLoading: (loading: boolean) => void;
  updateThread: (id: string, updates: Partial<Thread>) => void;
  removeThread: (id: string) => void;
  removeThreads: (ids: string[]) => void;
  setSearch: (query: string, threadIds: Set<string> | null) => void;
  clearSearch: () => void;
}

export const useThreadStore = create<ThreadState>((set, get) => ({
  threads: [],
  threadMap: new Map(),
  selectedThreadId: null,
  selectedThreadIds: new Set(),
  isLoading: false,
  searchQuery: "",
  searchThreadIds: null,
  pendingRemovalIds: new Set(),

  beginRemoval: (ids) =>
    set((state) => {
      const next = new Set(state.pendingRemovalIds);
      for (const id of ids) next.add(id);
      return { pendingRemovalIds: next };
    }),

  endRemoval: (ids) =>
    set((state) => {
      const next = new Set(state.pendingRemovalIds);
      for (const id of ids) next.delete(id);
      return { pendingRemovalIds: next };
    }),

  setThreads: (threads) =>
    set((state) => {
      // Never re-introduce a thread the user has just acted on while the server
      // call is still outstanding.
      const visible = state.pendingRemovalIds.size
        ? threads.filter((t) => !state.pendingRemovalIds.has(t.id))
        : threads;
      return { threads: visible, threadMap: new Map(visible.map((t) => [t.id, t])) };
    }),
  selectThread: (selectedThreadId) => set({ selectedThreadId, selectedThreadIds: new Set() }),
  toggleThreadSelection: (id) =>
    set((state) => {
      const next = new Set(state.selectedThreadIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return { selectedThreadIds: next };
    }),
  selectThreadRange: (id) => {
    const state = get();
    const threads = state.threads;
    // Find the anchor: last selected thread or the currently viewed thread
    const anchor = state.selectedThreadId ?? [...state.selectedThreadIds].pop();
    if (!anchor) {
      set({ selectedThreadIds: new Set([id]) });
      return;
    }
    const anchorIdx = threads.findIndex((t) => t.id === anchor);
    const targetIdx = threads.findIndex((t) => t.id === id);
    if (anchorIdx === -1 || targetIdx === -1) return;
    const start = Math.min(anchorIdx, targetIdx);
    const end = Math.max(anchorIdx, targetIdx);
    const rangeIds = threads.slice(start, end + 1).map((t) => t.id);
    set((s) => ({
      selectedThreadIds: new Set([...s.selectedThreadIds, ...rangeIds]),
    }));
  },
  clearMultiSelect: () => set({ selectedThreadIds: new Set() }),
  selectAll: () => {
    const threads = get().threads;
    set({ selectedThreadIds: new Set(threads.map((t) => t.id)) });
  },
  selectAllFromHere: () => {
    const { threads, selectedThreadId } = get();
    const idx = threads.findIndex((t) => t.id === selectedThreadId);
    const startIdx = idx === -1 ? 0 : idx;
    const ids = threads.slice(startIdx).map((t) => t.id);
    set((s) => ({
      selectedThreadIds: new Set([...s.selectedThreadIds, ...ids]),
    }));
  },
  setLoading: (isLoading) => set({ isLoading }),
  updateThread: (id, updates) =>
    set((state) => {
      const threads = state.threads.map((t) =>
        t.id === id ? { ...t, ...updates } : t,
      );
      const threadMap = new Map(state.threadMap);
      const existing = threadMap.get(id);
      if (existing) threadMap.set(id, { ...existing, ...updates });
      return { threads, threadMap };
    }),
  removeThread: (id) =>
    set((state) => {
      const threadMap = new Map(state.threadMap);
      threadMap.delete(id);
      const next = new Set(state.selectedThreadIds);
      next.delete(id);
      return {
        threads: state.threads.filter((t) => t.id !== id),
        threadMap,
        selectedThreadId: state.selectedThreadId === id ? null : state.selectedThreadId,
        selectedThreadIds: next,
      };
    }),
  removeThreads: (ids) =>
    set((state) => {
      const idsSet = new Set(ids);
      const threadMap = new Map(state.threadMap);
      for (const id of ids) threadMap.delete(id);
      const next = new Set(state.selectedThreadIds);
      for (const id of ids) next.delete(id);
      return {
        threads: state.threads.filter((t) => !idsSet.has(t.id)),
        threadMap,
        selectedThreadId: state.selectedThreadId && idsSet.has(state.selectedThreadId) ? null : state.selectedThreadId,
        selectedThreadIds: next,
      };
    }),
  setSearch: (query, threadIds) => set({ searchQuery: query, searchThreadIds: threadIds }),
  clearSearch: () => set({ searchQuery: "", searchThreadIds: null }),
}));

/**
 * The account a thread belongs to, for actions that must reach the right server.
 *
 * Actions have historically used the globally active account, which holds only
 * because every list is filtered to that one account. The moment a list can show
 * threads from more than one mailbox, that assumption sends archives, trashes and
 * label moves to the wrong server — silently, since the wrong server simply has
 * no such message. Reading the account off the thread is identical in the
 * single-account case and correct in both.
 *
 * Falls back to the supplied account when the thread is not in the current list.
 */
export function accountIdForThread(
  threadId: string,
  fallback: string | null,
): string | null {
  return useThreadStore.getState().threadMap.get(threadId)?.accountId ?? fallback;
}
