import type { ParsedMessage } from "../gmail/messageParser";

export type AccountProvider = "gmail_api" | "imap" | "caldav";

export interface EmailFolder {
  id: string;
  name: string;
  path: string;
  type: "system" | "user";
  specialUse: string | null;
  delimiter: string;
  messageCount: number;
  unreadCount: number;
}

export interface SyncResult {
  messages: ParsedMessage[];
  /**
   * How many messages this sync wrote.
   *
   * Syncs that stream to disk return no message bodies at all, so the length of
   * `messages` says nothing about whether anything arrived.
   */
  storedCount?: number;
  folderStatus?: {
    uidvalidity: number;
    lastUid: number;
    modseq?: number;
  };
  latestSyncToken?: string;
}

export interface EmailProvider {
  readonly accountId: string;
  readonly type: AccountProvider;

  // Folder/Label operations
  listFolders(): Promise<EmailFolder[]>;
  createFolder(name: string, parentPath?: string): Promise<EmailFolder>;
  deleteFolder(path: string): Promise<void>;
  renameFolder(path: string, newName: string): Promise<void>;

  // Sync operations
  initialSync(
    daysBack: number,
    onProgress?: (phase: string, current: number, total: number) => void,
  ): Promise<SyncResult>;
  deltaSync(syncToken: string): Promise<SyncResult>;

  // Message operations
  fetchMessage(messageId: string): Promise<ParsedMessage>;
  fetchAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }>;
  fetchRawMessage(messageId: string): Promise<string>;

  // Actions (operate on thread/message level)
  archive(threadId: string, messageIds: string[]): Promise<void>;
  trash(threadId: string, messageIds: string[]): Promise<void>;
  permanentDelete(threadId: string, messageIds: string[]): Promise<void>;
  markRead(
    threadId: string,
    messageIds: string[],
    read: boolean,
  ): Promise<void>;
  star(
    threadId: string,
    messageIds: string[],
    starred: boolean,
  ): Promise<void>;
  spam(
    threadId: string,
    messageIds: string[],
    isSpam: boolean,
  ): Promise<void>;
  moveToFolder(
    threadId: string,
    messageIds: string[],
    folderPath: string,
  ): Promise<void>;
  addLabel(threadId: string, labelId: string): Promise<void>;
  removeLabel(threadId: string, labelId: string): Promise<void>;

  // Send/Draft operations
  sendMessage(
    rawBase64Url: string,
    threadId?: string,
  ): Promise<{ id: string }>;
  createDraft(
    rawBase64Url: string,
    threadId?: string,
  ): Promise<{ draftId: string }>;
  updateDraft(
    draftId: string,
    rawBase64Url: string,
    threadId?: string,
  ): Promise<{ draftId: string }>;
  deleteDraft(draftId: string): Promise<void>;

  /**
   * Append a raw RFC822 message into a folder/mailbox of THIS account.
   * Used for cross-account move/assign: the raw source is fetched from one
   * account (fetchRawMessage) and appended into another account's folder.
   * @param folderPath destination folder path (IMAP) or label ID (Gmail)
   * @param rawBase64Url base64url-encoded RFC822 message
   * @param flags optional IMAP flags string (e.g. "(\\Seen)")
   */
  appendRawMessage(
    folderPath: string,
    rawBase64Url: string,
    flags?: string,
  ): Promise<{ id?: string }>;

  // Connection
  testConnection(): Promise<{ success: boolean; message: string }>;
  getProfile(): Promise<{ email: string; name?: string }>;
}
