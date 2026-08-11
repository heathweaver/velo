import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDeleteThread = vi.fn().mockResolvedValue(undefined);
const mockGetMessagesForThread = vi.fn().mockResolvedValue([]);
const mockGetEmailProvider = vi.fn();
const mockGetGmailClient = vi.fn();
const mockFindSpecialFolder = vi.fn();

vi.mock("../db/threads", () => ({
  deleteThread: (...args: unknown[]) => mockDeleteThread(...args),
}));
vi.mock("../db/messages", () => ({
  getMessagesForThread: (...args: unknown[]) => mockGetMessagesForThread(...args),
}));
vi.mock("../email/providerFactory", () => ({
  getEmailProvider: (...args: unknown[]) => mockGetEmailProvider(...args),
}));
vi.mock("./tokenManager", () => ({
  getGmailClient: (...args: unknown[]) => mockGetGmailClient(...args),
}));
vi.mock("../imap/messageHelper", () => ({
  findSpecialFolder: (...args: unknown[]) => mockFindSpecialFolder(...args),
}));

import { deleteDraftsForThread } from "./draftDeletion";

function gmailClientWith(
  drafts: { id: string; message: { id: string; threadId: string } }[],
) {
  return {
    listDrafts: vi.fn().mockResolvedValue(drafts),
    deleteDraft: vi.fn().mockResolvedValue(undefined),
  };
}

describe("deleteDraftsForThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteThread.mockResolvedValue(undefined);
    mockGetMessagesForThread.mockResolvedValue([]);
  });

  describe("gmail accounts", () => {
    beforeEach(() => {
      mockGetEmailProvider.mockResolvedValue({ type: "gmail_api" });
    });

    it("deletes every draft belonging to the thread", async () => {
      const client = gmailClientWith([
        { id: "draft-1", message: { id: "m1", threadId: "thread-A" } },
        { id: "draft-2", message: { id: "m2", threadId: "thread-A" } },
        { id: "draft-3", message: { id: "m3", threadId: "thread-B" } },
      ]);
      mockGetGmailClient.mockResolvedValue(client);

      await deleteDraftsForThread("account-1", "thread-A");

      expect(client.deleteDraft).toHaveBeenCalledTimes(2);
      expect(client.deleteDraft).toHaveBeenCalledWith("draft-1");
      expect(client.deleteDraft).toHaveBeenCalledWith("draft-2");
    });

    it("removes the thread locally afterwards", async () => {
      mockGetGmailClient.mockResolvedValue(gmailClientWith([]));

      await deleteDraftsForThread("account-1", "thread-A");

      expect(mockDeleteThread).toHaveBeenCalledWith("account-1", "thread-A");
    });
  });

  describe("imap accounts", () => {
    it("deletes messages that live in the Drafts folder", async () => {
      // This whole path used to be unreachable: the helper took a GmailClient,
      // so on IMAP the caller threw and drafts stayed on the server.
      const deleteDraft = vi.fn().mockResolvedValue(undefined);
      mockGetEmailProvider.mockResolvedValue({ type: "imap", deleteDraft });
      mockFindSpecialFolder.mockResolvedValue("INBOX.Drafts");
      mockGetMessagesForThread.mockResolvedValue([
        { id: "imap-acc-1-INBOX.Drafts-12" },
        { id: "imap-acc-1-INBOX-99" },
      ]);

      await deleteDraftsForThread("account-1", "thread-A");

      expect(deleteDraft).toHaveBeenCalledTimes(1);
      expect(deleteDraft).toHaveBeenCalledWith("imap-acc-1-INBOX.Drafts-12");
    });

    it("leaves ordinary mail in the thread alone", async () => {
      // Deleting every message in the thread would destroy real mail, so only
      // those addressed inside the Drafts folder may be touched.
      const deleteDraft = vi.fn().mockResolvedValue(undefined);
      mockGetEmailProvider.mockResolvedValue({ type: "imap", deleteDraft });
      mockFindSpecialFolder.mockResolvedValue("INBOX.Drafts");
      mockGetMessagesForThread.mockResolvedValue([
        { id: "imap-acc-1-INBOX-99" },
        { id: "imap-acc-1-INBOX.Archive-7" },
      ]);

      await deleteDraftsForThread("account-1", "thread-A");

      expect(deleteDraft).not.toHaveBeenCalled();
      expect(mockDeleteThread).toHaveBeenCalledWith("account-1", "thread-A");
    });

    it("does nothing on the server when no Drafts folder exists", async () => {
      const deleteDraft = vi.fn().mockResolvedValue(undefined);
      mockGetEmailProvider.mockResolvedValue({ type: "imap", deleteDraft });
      mockFindSpecialFolder.mockResolvedValue(null);

      await deleteDraftsForThread("account-1", "thread-A");

      expect(deleteDraft).not.toHaveBeenCalled();
      expect(mockDeleteThread).toHaveBeenCalledWith("account-1", "thread-A");
    });
  });
});
