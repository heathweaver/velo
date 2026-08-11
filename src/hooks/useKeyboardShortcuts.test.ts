import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies needed for the hook to mount and dispatch events.
// The hook reads store state and calls navigate/emailActions — only mock
// what's needed for the three event-dispatch tests below.
vi.mock("@/stores/uiStore", () => ({
  useUIStore: { getState: () => ({ inboxViewMode: "unified", toggleSidebar: vi.fn() }) },
}));
export const mockSelectThreadRange = vi.fn();
export const mockThreadState: {
  threads: { id: string }[];
  selectedThreadIds: Set<string>;
} = { threads: [], selectedThreadIds: new Set() };

vi.mock("@/stores/threadStore", () => ({
  // Mirrors the real helper: without the thread in the map it returns the
  // account passed in, which is what these single-account tests expect.
  accountIdForThread: (_threadId: string, fallback: string | null) => fallback,
  useThreadStore: {
    getState: () => ({
      threads: mockThreadState.threads,
      selectedThreadIds: mockThreadState.selectedThreadIds,
      selectThreadRange: mockSelectThreadRange,
      removeThread: vi.fn(),
      removeThreads: vi.fn(),
      updateThread: vi.fn(),
      clearMultiSelect: vi.fn(),
      selectAll: vi.fn(),
      selectAllFromHere: vi.fn(),
    }),
  },
}));
vi.mock("@/stores/composerStore", () => ({
  useComposerStore: { getState: () => ({ isOpen: false, openComposer: vi.fn(), closeComposer: vi.fn() }) },
}));
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: { getState: () => ({ activeAccountId: null }) },
}));
vi.mock("@/stores/shortcutStore", () => ({
  useShortcutStore: {
    getState: () => ({
      keyMap: {
        "app.askInbox": "i",
        "app.commandPalette": "/",
        "app.toggleSidebar": "Ctrl+Shift+E",
        "app.help": "?",
      },
    }),
  },
}));
vi.mock("@/stores/contextMenuStore", () => ({
  useContextMenuStore: { getState: () => ({ menuType: null, closeMenu: vi.fn() }) },
}));
vi.mock("@/router/navigate", () => ({
  navigateToLabel: vi.fn(),
  navigateToThread: vi.fn(),
  navigateBack: vi.fn(),
  getActiveLabel: () => "inbox",
  getSelectedThreadId: () => null,
}));
vi.mock("@/services/emailActions", () => ({
  archiveThread: vi.fn(),
  trashThread: vi.fn(),
  permanentDeleteThread: vi.fn(),
  starThread: vi.fn(),
  spamThread: vi.fn(),
}));
vi.mock("@/services/db/threads", () => ({
  deleteThread: vi.fn(),
  pinThread: vi.fn(),
  unpinThread: vi.fn(),
  muteThread: vi.fn(),
  unmuteThread: vi.fn(),
}));
vi.mock("@/services/gmail/draftDeletion", () => ({ deleteDraftsForThread: vi.fn() }));
vi.mock("@/services/gmail/tokenManager", () => ({ getGmailClient: vi.fn() }));
vi.mock("@/services/db/messages", () => ({ getMessagesForThread: vi.fn() }));
vi.mock("@/components/email/MessageItem", () => ({ parseUnsubscribeUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/services/gmail/syncManager", () => ({ triggerSync: vi.fn() }));

import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches velo-toggle-ask-inbox when 'i' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("velo-toggle-ask-inbox", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "i", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("velo-toggle-ask-inbox", listener);
  });

  it("dispatches velo-toggle-command-palette when '/' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("velo-toggle-command-palette", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("velo-toggle-command-palette", listener);
  });

  it("dispatches velo-toggle-shortcuts-help when '?' is pressed", () => {
    renderHook(() => useKeyboardShortcuts());

    const listener = vi.fn();
    window.addEventListener("velo-toggle-shortcuts-help", listener);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true }),
    );

    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener("velo-toggle-shortcuts-help", listener);
  });

  describe("shift+arrow range selection", () => {
    beforeEach(() => {
      mockThreadState.threads = [
        { id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" },
      ];
      mockThreadState.selectedThreadIds = new Set();
      mockSelectThreadRange.mockClear();
    });

    it("extends the selection downward from the current edge", () => {
      // Shift+click could build a range but the keyboard could not, so a
      // selection had to be started with the mouse.
      mockThreadState.selectedThreadIds = new Set(["t2"]);
      renderHook(() => useKeyboardShortcuts());

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
      );

      expect(mockSelectThreadRange).toHaveBeenCalledWith("t3");
    });

    it("extends upward from the current edge", () => {
      mockThreadState.selectedThreadIds = new Set(["t3"]);
      renderHook(() => useKeyboardShortcuts());

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }),
      );

      expect(mockSelectThreadRange).toHaveBeenCalledWith("t2");
    });

    it("stops at the end of the list rather than wrapping", () => {
      mockThreadState.selectedThreadIds = new Set(["t4"]);
      renderHook(() => useKeyboardShortcuts());

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
      );

      expect(mockSelectThreadRange).toHaveBeenCalledWith("t4");
    });

    it("starts a selection at the first thread when nothing is selected", () => {
      renderHook(() => useKeyboardShortcuts());

      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
      );

      expect(mockSelectThreadRange).toHaveBeenCalledWith("t1");
    });
  });
});
