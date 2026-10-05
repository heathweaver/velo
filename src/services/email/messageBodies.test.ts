import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbMessage } from "../db/messages";

vi.mock("./providerFactory", () => ({
  getEmailProvider: vi.fn(),
}));

vi.mock("../db/messages", () => ({
  getMessagesForThread: vi.fn(),
  upsertMessage: vi.fn(),
}));

vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));

import { getEmailProvider } from "./providerFactory";
import { getMessagesForThread, upsertMessage } from "../db/messages";
import { ensureMessageBodies } from "./messageBodies";

function makeMessage(overrides: Partial<DbMessage> = {}): DbMessage {
  return {
    id: "msg-1",
    account_id: "acct-1",
    thread_id: "thread-1",
    from_address: "sender@example.com",
    from_name: "Sender",
    to_addresses: "recipient@example.com",
    cc_addresses: "",
    bcc_addresses: "",
    reply_to: "",
    subject: "Hello",
    snippet: "Preview",
    date: 1_700_000_000_000,
    is_read: 1,
    is_starred: 0,
    body_html: null,
    body_text: null,
    body_cached: 0,
    raw_size: 0,
    internal_date: 1_700_000_000_000,
    list_unsubscribe: null,
    list_unsubscribe_post: null,
    auth_results: null,
    message_id_header: null,
    references_header: null,
    in_reply_to_header: null,
    imap_uid: null,
    imap_folder: null,
    ...overrides,
  };
}

describe("ensureMessageBodies", () => {
  const mockGetEmailProvider = vi.mocked(getEmailProvider);
  const mockUpsertMessage = vi.mocked(upsertMessage);
  const mockGetMessagesForThread = vi.mocked(getMessagesForThread);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns messages unchanged when bodies are already cached", async () => {
    const messages = [makeMessage({ body_cached: 1, body_text: "Already here" })];
    const result = await ensureMessageBodies("acct-1", messages);
    expect(result).toBe(messages);
    expect(mockGetEmailProvider).not.toHaveBeenCalled();
  });

  it("fetches and persists bodies for metadata-only messages", async () => {
    const messages = [makeMessage()];
    const refreshed = [makeMessage({ body_cached: 1, body_text: "Full body" })];

    mockGetEmailProvider.mockResolvedValue({
      fetchMessage: vi.fn().mockResolvedValue({
        id: "msg-1",
        fromAddress: "sender@example.com",
        fromName: "Sender",
        toAddresses: "recipient@example.com",
        ccAddresses: "",
        bccAddresses: "",
        replyTo: "",
        subject: "Hello",
        snippet: "Full body",
        date: 1_700_000_000_000,
        isRead: true,
        isStarred: false,
        bodyHtml: "<p>Full body</p>",
        bodyText: "Full body",
        rawSize: 100,
        internalDate: 1_700_000_000_000,
        attachments: [],
        listUnsubscribe: null,
        listUnsubscribePost: null,
        authResults: null,
      }),
    } as never);

    mockGetMessagesForThread.mockResolvedValue(refreshed);

    const result = await ensureMessageBodies("acct-1", messages);

    expect(mockUpsertMessage).toHaveBeenCalledOnce();
    expect(mockGetMessagesForThread).toHaveBeenCalledWith("acct-1", "thread-1");
    expect(result).toEqual(refreshed);
  });
});
