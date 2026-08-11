import { describe, it, expect, beforeEach, vi } from "vitest";
import { moveThreadToAccount } from "./crossAccountMove";

// ---- Mocks ----
const getMessagesForThread = vi.fn();
const trashThread = vi.fn();
const getEmailProvider = vi.fn();
const removeThread = vi.fn();
const syncAccountNow = vi.fn(() => Promise.resolve());

vi.mock("./db/messages", () => ({
  getMessagesForThread: (...args: unknown[]) => getMessagesForThread(...args),
}));

vi.mock("./emailActions", () => ({
  trashThread: (...args: unknown[]) => trashThread(...args),
}));

vi.mock("./gmail/syncManager", () => ({
  syncAccountNow: (...args: unknown[]) => syncAccountNow(...args),
}));

vi.mock("./email/providerFactory", () => ({
  getEmailProvider: (...args: unknown[]) => getEmailProvider(...args),
}));

vi.mock("@/stores/threadStore", () => ({
  // Mirrors the real helper: without the thread in the map it returns the
  // account passed in, which is what these single-account tests expect.
  accountIdForThread: (_threadId: string, fallback: string | null) => fallback,
  useThreadStore: {
    getState: () => ({ removeThread }),
  },
}));

function makeProvider() {
  return {
    fetchRawMessage: vi.fn(() => Promise.resolve("From: a@b.com\r\n\r\nhi")),
    appendRawMessage: vi.fn(() => Promise.resolve({ id: "new-1" })),
  };
}

describe("moveThreadToAccount", () => {
  let src: ReturnType<typeof makeProvider>;
  let dest: ReturnType<typeof makeProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    src = makeProvider();
    dest = makeProvider();
    getEmailProvider.mockImplementation((id: string) =>
      Promise.resolve(id === "src-acct" ? src : dest),
    );
    getMessagesForThread.mockResolvedValue([
      { id: "imap-src-acct-INBOX-1", is_read: 1 },
      { id: "imap-src-acct-INBOX-2", is_read: 0 },
    ]);
    trashThread.mockResolvedValue({ success: true });
    // jsdom provides window; ensure dispatchEvent exists
    vi.spyOn(window, "dispatchEvent");
  });

  it("rejects moving to the same account", async () => {
    await expect(
      moveThreadToAccount("src-acct", "t1", "src-acct", "INBOX"),
    ).rejects.toThrow(/same/i);
  });

  it("throws when the thread has no messages", async () => {
    getMessagesForThread.mockResolvedValue([]);
    await expect(
      moveThreadToAccount("src-acct", "t1", "dest-acct", "INBOX"),
    ).rejects.toThrow(/no messages/i);
    expect(trashThread).not.toHaveBeenCalled();
  });

  it("appends every message to the destination then trashes the source", async () => {
    const result = await moveThreadToAccount(
      "src-acct",
      "t1",
      "dest-acct",
      "INBOX",
    );

    expect(src.fetchRawMessage).toHaveBeenCalledTimes(2);
    expect(dest.appendRawMessage).toHaveBeenCalledTimes(2);
    // Reassigned mail always arrives UNREAD (no \Seen flag), even if it was
    // already read in the source mailbox.
    expect(dest.appendRawMessage).toHaveBeenNthCalledWith(1, "INBOX", expect.any(String));
    expect(dest.appendRawMessage).toHaveBeenNthCalledWith(2, "INBOX", expect.any(String));
    expect(trashThread).toHaveBeenCalledWith("src-acct", "t1", [
      "imap-src-acct-INBOX-1",
      "imap-src-acct-INBOX-2",
    ]);
    expect(removeThread).toHaveBeenCalledWith("t1");
    // Destination is synced immediately so the moved mail shows up at once.
    expect(syncAccountNow).toHaveBeenCalledWith("dest-acct");
    expect(result).toEqual({ moved: 2 });
  });

  it("does NOT trash the source if an append fails", async () => {
    dest.appendRawMessage.mockRejectedValueOnce(new Error("APPEND failed"));

    await expect(
      moveThreadToAccount("src-acct", "t1", "dest-acct", "INBOX"),
    ).rejects.toThrow(/APPEND failed/);

    expect(trashThread).not.toHaveBeenCalled();
    expect(removeThread).not.toHaveBeenCalled();
  });
});
