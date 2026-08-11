import type { EmailProvider, EmailFolder, SyncResult } from "./types";
import type { ParsedMessage } from "../gmail/messageParser";
import { buildImapConfig, buildSmtpConfig } from "../imap/imapConfigBuilder";
import { imapInitialSync, imapDeltaSync, imapMessageToParsedMessage } from "../imap/imapSync";
import { mapFolderToLabel, getSyncableFolders } from "../imap/folderMapper";
import {
  imapListFolders,
  imapSetFlags,
  imapMoveMessages,
  imapDeleteMessages,
  imapFetchMessageBody,
  imapFetchAttachment,
  imapFetchRawMessage,
  imapTestConnection,
  imapAppendMessage,
  imapSearchMessageId,
  smtpSendEmail,
  smtpTestConnection,
  type ImapConfig,
  type SmtpConfig,
} from "../imap/tauriCommands";
import { getAccount, type DbAccount } from "../db/accounts";
import { getLabelsForAccount } from "../db/labels";
import { findSpecialFolder } from "../imap/messageHelper";
import { ensureFreshToken } from "../oauth/oauthTokenManager";
import { upsertMessage, getMessagesForThread } from "../db/messages";
import { upsertThread, setThreadLabels, getThreadLabelIds } from "../db/threads";

/**
 * Decode base64url (Gmail/RFC 4648 URL-safe, no padding) to a UTF-8 string.
 */
function base64UrlDecode(input: string): string {
  // Convert base64url to standard base64
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding if needed
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Pull the Message-ID header out of a raw message, angle brackets included.
 */
function extractMessageId(raw: string): string | null {
  const match = raw.match(/^Message-ID:\s*(<[^>]+>)/im);
  return match?.[1] ?? null;
}

/**
 * Parse basic RFC 2822 headers from a raw email string.
 * Returns a map of header name (lowercase) → header value.
 */
function parseBasicHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Headers end at the first blank line
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headerSection = headerEnd !== -1 ? raw.slice(0, headerEnd) : raw;

  // Unfold continuation lines (lines starting with space/tab are continuations)
  const unfolded = headerSection.replace(/\r\n([ \t])/g, " ");

  for (const line of unfolded.split("\r\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    headers.set(name, value);
  }

  return headers;
}

/**
 * Extract a plain-text snippet from a raw RFC 2822 email body.
 */
function extractSnippet(raw: string, maxLen = 200): string {
  const bodyStart = raw.indexOf("\r\n\r\n");
  if (bodyStart === -1) return "";

  let body = raw.slice(bodyStart + 4);

  // For multipart messages, try to find the text/plain part
  const contentType = parseBasicHeaders(raw).get("content-type") ?? "";
  const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1]!;
    const parts = body.split(`--${boundary}`);
    for (const part of parts) {
      if (part.toLowerCase().includes("content-type: text/plain")) {
        const partBodyStart = part.indexOf("\r\n\r\n");
        if (partBodyStart !== -1) {
          body = part.slice(partBodyStart + 4);
          break;
        }
      }
    }
  }

  // Strip HTML tags if present, trim, and truncate
  return body
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/**
 * EmailProvider adapter for IMAP/SMTP accounts.
 * Delegates to Tauri IMAP/SMTP commands via the imapSync engine.
 */
export class ImapSmtpProvider implements EmailProvider {
  readonly accountId: string;
  readonly type = "imap" as const;

  private _imapConfig: ImapConfig | null = null;
  private _smtpConfig: SmtpConfig | null = null;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  private async getAccount(): Promise<DbAccount> {
    const account = await getAccount(this.accountId);
    if (!account) {
      throw new Error(`Account ${this.accountId} not found`);
    }
    return account;
  }

  private async getImapConfig(): Promise<ImapConfig> {
    const account = await this.getAccount();
    if (account.auth_method === "oauth2") {
      // OAuth accounts need a fresh token every time
      const token = await ensureFreshToken(account);
      return buildImapConfig(account, token);
    }
    if (!this._imapConfig) {
      this._imapConfig = buildImapConfig(account);
    }
    return this._imapConfig;
  }

  private async getSmtpConfig(): Promise<SmtpConfig> {
    const account = await this.getAccount();
    if (account.auth_method === "oauth2") {
      const token = await ensureFreshToken(account);
      return buildSmtpConfig(account, token);
    }
    if (!this._smtpConfig) {
      this._smtpConfig = buildSmtpConfig(account);
    }
    return this._smtpConfig;
  }

  /**
   * Invalidate cached configs (e.g., after password change).
   */
  clearConfigCache(): void {
    this._imapConfig = null;
    this._smtpConfig = null;
  }

  // ---- Folder/Label operations ----

  async listFolders(): Promise<EmailFolder[]> {
    const config = await this.getImapConfig();
    const imapFolders = await imapListFolders(config);
    const syncable = getSyncableFolders(imapFolders);

    return syncable.map((f) => {
      const mapping = mapFolderToLabel(f);
      return {
        id: mapping.labelId,
        name: mapping.labelName,
        path: f.path,
        type: mapping.type as "system" | "user",
        specialUse: f.special_use,
        delimiter: f.delimiter,
        messageCount: f.exists,
        unreadCount: f.unseen,
      };
    });
  }

  async createFolder(
    _name: string,
    _parentPath?: string,
  ): Promise<EmailFolder> {
    throw new Error(
      "Creating folders is not supported for IMAP accounts via the current command set. " +
        "Please create the folder directly on the mail server.",
    );
  }

  async deleteFolder(_path: string): Promise<void> {
    throw new Error(
      "Deleting folders is not supported for IMAP accounts via the current command set. " +
        "Please delete the folder directly on the mail server.",
    );
  }

  async renameFolder(_path: string, _newName: string): Promise<void> {
    throw new Error(
      "Renaming folders is not supported for IMAP accounts via the current command set. " +
        "Please rename the folder directly on the mail server.",
    );
  }

  // ---- Sync operations ----

  async initialSync(
    daysBack: number,
    onProgress?: (phase: string, current: number, total: number) => void,
  ): Promise<SyncResult> {
    return imapInitialSync(this.accountId, daysBack, onProgress ? (p) => {
      onProgress(p.phase, p.current, p.total);
    } : undefined);
  }

  async deltaSync(_syncToken: string): Promise<SyncResult> {
    return imapDeltaSync(this.accountId);
  }

  // ---- Message operations ----

  async fetchMessage(messageId: string): Promise<ParsedMessage> {
    const { folder, uid } = this.parseImapMessageId(messageId);

    if (uid === null || !folder) {
      throw new Error(`Invalid IMAP message ID format: ${messageId}`);
    }

    const config = await this.getImapConfig();
    const imapMsg = await imapFetchMessageBody(config, folder, uid);

    const { parsed } = imapMessageToParsedMessage(
      imapMsg,
      this.accountId,
      folder,
    );
    parsed.id = messageId;

    return parsed;
  }

  async fetchAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ data: string; size: number }> {
    const { folder, uid } = this.parseImapMessageId(messageId);

    if (uid === null || !folder) {
      throw new Error(`Invalid IMAP message ID format: ${messageId}`);
    }

    const config = await this.getImapConfig();
    const data = await imapFetchAttachment(config, folder, uid, attachmentId);
    return { data, size: data.length };
  }

  async fetchRawMessage(messageId: string): Promise<string> {
    const { folder, uid } = this.parseImapMessageId(messageId);

    if (uid === null || !folder) {
      throw new Error(`Invalid IMAP message ID format: ${messageId}`);
    }

    const config = await this.getImapConfig();
    return imapFetchRawMessage(config, folder, uid);
  }

  // ---- Actions ----

  async archive(
    _threadId: string,
    _messageIds: string[],
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, _messageIds),
    );

    // Resolve the Archive folder: the \Archive special-use first, then common
    // Hostinger/cPanel layouts (INBOX.Archive / Archive / INBOX.Archives).
    const archiveFolder = await this.resolveSpecialFolder(config, "\\Archive", [
      "INBOX.Archive",
      "Archive",
      "INBOX.Archives",
      "Archives",
    ]);
    if (!archiveFolder) {
      throw new Error(
        "No Archive folder found on the server. Create an 'Archive' folder in your mailbox to enable archiving.",
      );
    }

    for (const [folder, uids] of grouped) {
      if (folder === archiveFolder) continue;
      await imapMoveMessages(config, folder, uids, archiveFolder);
    }
  }

  /**
   * Resolve a special-use folder path (Trash/Junk/Archive…), verifying the
   * candidate actually exists on the server. Servers vary in naming, e.g.
   * Hostinger uses "INBOX.Trash"/"INBOX.Junk"/"INBOX.Archive". Prefers the
   * special-use label, then the provided fallbacks. Returns null if none exist.
   */
  private async resolveSpecialFolder(
    config: ImapConfig,
    specialUse: string,
    fallbacks: string[],
  ): Promise<string | null> {
    const special = await findSpecialFolder(this.accountId, specialUse);
    const candidates = [special, ...fallbacks].filter(
      (c): c is string => !!c,
    );

    let existing: Set<string>;
    try {
      const folders = await imapListFolders(config);
      existing = new Set(folders.map((f) => f.raw_path));
    } catch {
      // If we can't list, fall back to the special-use value or first candidate.
      return special ?? candidates[0] ?? null;
    }

    for (const c of candidates) {
      if (existing.has(c)) return c;
    }
    return special; // may still be a valid (non-listed) path, or null
  }

  async trash(
    _threadId: string,
    _messageIds: string[],
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, _messageIds),
    );
    const trashFolder = await this.resolveSpecialFolder(config, "\\Trash", [
      "INBOX.Trash",
      "Trash",
      "INBOX.Deleted Items",
      "Deleted Items",
    ]);
    if (!trashFolder) {
      throw new Error(
        "No Trash folder found on the server. Create a 'Trash' folder in your mailbox to enable deleting.",
      );
    }

    for (const [folder, uids] of grouped) {
      if (folder === trashFolder) continue;
      await imapMoveMessages(config, folder, uids, trashFolder);
    }
  }

  async permanentDelete(
    _threadId: string,
    _messageIds: string[],
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, _messageIds),
    );

    for (const [folder, uids] of grouped) {
      await imapDeleteMessages(config, folder, uids);
    }
  }

  async markRead(
    _threadId: string,
    _messageIds: string[],
    read: boolean,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, _messageIds),
    );

    for (const [folder, uids] of grouped) {
      await imapSetFlags(config, folder, uids, ["Seen"], read);
    }
  }

  async star(
    _threadId: string,
    _messageIds: string[],
    starred: boolean,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, _messageIds),
    );

    for (const [folder, uids] of grouped) {
      await imapSetFlags(config, folder, uids, ["Flagged"], starred);
    }
  }

  async spam(
    _threadId: string,
    _messageIds: string[],
    isSpam: boolean,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, _messageIds),
    );
    let destination: string;
    if (isSpam) {
      const junkFolder = await this.resolveSpecialFolder(config, "\\Junk", [
        "INBOX.Junk",
        "Junk",
        "INBOX.Spam",
        "Spam",
      ]);
      if (!junkFolder) {
        throw new Error(
          "No Junk/Spam folder found on the server. Create a 'Junk' folder in your mailbox to enable spam.",
        );
      }
      destination = junkFolder;
    } else {
      destination = "INBOX";
    }

    for (const [folder, uids] of grouped) {
      if (folder === destination) continue;
      await imapMoveMessages(config, folder, uids, destination);
    }
  }

  async moveToFolder(
    _threadId: string,
    _messageIds: string[],
    folderPath: string,
  ): Promise<void> {
    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, _messageIds),
    );

    for (const [folder, uids] of grouped) {
      if (folder === folderPath) continue;
      await imapMoveMessages(config, folder, uids, folderPath);
    }
  }

  /**
   * IMAP has no native labels, but Velo's labels are already backed by real
   * folders: every label carries the imap_folder_path it was discovered from.
   * Applying a label therefore means moving the thread's messages into that
   * folder, which is what the UI's "move to <label>" already implies and what
   * makes the change visible in other clients.
   *
   * Labels with no folder behind them (UNREAD, STARRED — server flags, handled
   * by markRead/star) are left alone.
   */
  async addLabel(_threadId: string, _labelId: string): Promise<void> {
    const target = await this.folderForLabel(_labelId);
    if (!target) return;

    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, []),
    );

    for (const [folder, uids] of grouped) {
      if (folder === target) continue;
      await imapMoveMessages(config, folder, uids, target);
    }
  }

  /**
   * Resolve a label id to the IMAP folder backing it, or null when the label is
   * a server flag rather than a folder.
   */
  private async folderForLabel(labelId: string): Promise<string | null> {
    const labels = await getLabelsForAccount(this.accountId);
    const label = labels.find((l) => l.id === labelId);

    if (!label) {
      console.warn(`[imap] unknown label ${labelId}; not moving anything`);
      return null;
    }
    if (!label.imap_folder_path) {
      // UNREAD/STARRED and similar are flags, not folders.
      return null;
    }
    return label.imap_folder_path;
  }

  /**
   * Removing a folder-backed label means the thread should no longer live in
   * that folder, so move it back to INBOX. Only messages currently sitting in
   * the label's folder are touched.
   */
  async removeLabel(_threadId: string, _labelId: string): Promise<void> {
    const source = await this.folderForLabel(_labelId);
    if (!source || source === "INBOX") return;

    const config = await this.getImapConfig();
    const grouped = this.groupByFolder(
      await this.resolveMessageIds(_threadId, []),
    );

    const uids = grouped.get(source);
    if (!uids?.length) return;

    await imapMoveMessages(config, source, uids, "INBOX");
  }

  // ---- Send/Draft operations ----

  async sendMessage(
    rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ id: string }> {
    const smtpConfig = await this.getSmtpConfig();
    const result = await smtpSendEmail(smtpConfig, rawBase64Url);
    if (!result.success) {
      throw new Error(`SMTP send failed: ${result.message}`);
    }

    const messageId = `imap-sent-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Save sent message to local DB so it appears in Sent folder immediately
    try {
      await this.saveSentMessageLocally(rawBase64Url, messageId, _threadId);
    } catch (err) {
      console.warn("[IMAP] Failed to save sent message to local DB:", err);
    }

    // Copy sent message to Sent folder on IMAP server
    try {
      const imapConfig = await this.getImapConfig();
      const sentFolder =
        (await findSpecialFolder(this.accountId, "\\Sent")) ?? "Sent";
      await imapAppendMessage(imapConfig, sentFolder, rawBase64Url, "(\\Seen)");
    } catch (err) {
      // Non-fatal: message was sent successfully, just not copied to server Sent folder
      console.error(
        "[IMAP] Failed to copy sent message to Sent folder on server:",
        err,
      );
    }

    return { id: messageId };
  }

  /**
   * Save a sent message to the local SQLite DB with the SENT label.
   * This ensures the message appears in the Sent folder view immediately
   * without waiting for the next IMAP delta sync.
   */
  private async saveSentMessageLocally(
    rawBase64Url: string,
    messageId: string,
    threadId?: string,
  ): Promise<void> {
    const raw = base64UrlDecode(rawBase64Url);
    const headers = parseBasicHeaders(raw);
    const snippet = extractSnippet(raw);

    const from = headers.get("from") ?? "";
    const to = headers.get("to") ?? "";
    const cc = headers.get("cc") ?? null;
    const subject = headers.get("subject") ?? null;
    const messageIdHeader = headers.get("message-id") ?? null;
    const inReplyTo = headers.get("in-reply-to") ?? null;
    const references = headers.get("references") ?? null;
    const now = Date.now();

    // For replies, add the SENT label to the existing thread.
    // For new compositions, create a new thread.
    const effectiveThreadId = threadId ?? messageId;

    if (threadId) {
      // Reply: add SENT label to existing thread
      const existingLabels = await getThreadLabelIds(this.accountId, threadId);
      if (!existingLabels.includes("SENT")) {
        await setThreadLabels(this.accountId, threadId, [...existingLabels, "SENT"]);
      }
    } else {
      // New thread: create thread record
      await upsertThread({
        id: effectiveThreadId,
        accountId: this.accountId,
        subject,
        snippet,
        lastMessageAt: now,
        messageCount: 1,
        isRead: true,
        isStarred: false,
        isImportant: false,
        hasAttachments: false,
      });
      await setThreadLabels(this.accountId, effectiveThreadId, ["SENT"]);
    }

    // Extract sender name from "Name <email>" format
    const fromNameMatch = from.match(/^([^<]*)<[^>]+>/);
    const fromName = fromNameMatch ? fromNameMatch[1]!.trim() : null;
    const fromAddress = from.replace(/.*<([^>]+)>.*/, "$1").trim();

    // Parse body for HTML and text
    const bodyStart = raw.indexOf("\r\n\r\n");
    const bodyHtml = bodyStart !== -1 ? raw.slice(bodyStart + 4) : null;

    await upsertMessage({
      id: messageId,
      accountId: this.accountId,
      threadId: effectiveThreadId,
      fromAddress,
      fromName,
      toAddresses: to,
      ccAddresses: cc,
      bccAddresses: null, // BCC is intentionally omitted from stored messages
      replyTo: null,
      subject,
      snippet,
      date: now,
      isRead: true,
      isStarred: false,
      bodyHtml: bodyHtml ? bodyHtml.slice(0, 50000) : null, // Limit stored body size
      bodyText: snippet,
      rawSize: raw.length,
      internalDate: now,
      messageIdHeader,
      referencesHeader: references,
      inReplyToHeader: inReplyTo,
    });
  }

  async createDraft(
    rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ draftId: string }> {
    const config = await this.getImapConfig();
    const draftsFolder =
      (await findSpecialFolder(this.accountId, "\\Drafts")) ?? "Drafts";

    await imapAppendMessage(config, draftsFolder, rawBase64Url, "(\\Draft)");

    // Resolve the UID the server assigned, so this draft can be deleted later.
    // APPEND only reports it via UIDPLUS, which async-imap does not surface, so
    // look it up by the Message-ID the message was built with. Without a real
    // UID the id below cannot be mapped back to a server message and every sent
    // draft stays in the Drafts folder forever.
    // Decoding is best-effort: a malformed payload must not stop the draft
    // being created, only its UID being resolved.
    let messageId: string | null = null;
    try {
      messageId = extractMessageId(base64UrlDecode(rawBase64Url));
    } catch {
      messageId = null;
    }

    if (messageId) {
      try {
        const uid = await imapSearchMessageId(config, draftsFolder, messageId);
        if (uid !== null) {
          return { draftId: `imap-${this.accountId}-${draftsFolder}-${uid}` };
        }
      } catch (err) {
        console.warn("Could not resolve appended draft UID:", err);
      }
    }

    // Fall back to an id that at least identifies the draft locally. Deletion
    // will warn rather than silently believing it succeeded.
    const draftId = `imap-draft-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return { draftId };
  }

  async updateDraft(
    draftId: string,
    rawBase64Url: string,
    _threadId?: string,
  ): Promise<{ draftId: string }> {
    // Delete the old draft first, then create a new one
    try {
      await this.deleteDraft(draftId);
    } catch {
      // Old draft may already be gone; continue with creating the new one
    }

    return this.createDraft(rawBase64Url, _threadId);
  }

  async deleteDraft(draftId: string): Promise<void> {
    // Try to parse draft ID to get folder + UID info
    // Draft IDs from IMAP are in message ID format: imap-{accountId}-{folder}-{uid}
    const { folder, uid } = this.parseImapMessageId(draftId);

    if (uid !== null && folder) {
      const config = await this.getImapConfig();
      await imapDeleteMessages(config, folder, [uid]);
    } else {
      // Generated draft IDs (imap-draft-...) can't be mapped back to a server UID
      console.warn(
        `Draft ${draftId} has a generated ID and cannot be deleted from server. ` +
          "It will be cleaned up on next sync.",
      );
    }
  }

  async appendRawMessage(
    folderPath: string,
    rawBase64Url: string,
    flags?: string,
  ): Promise<{ id?: string }> {
    const config = await this.getImapConfig();
    await imapAppendMessage(config, folderPath, rawBase64Url, flags);
    // IMAP APPEND does not return the new UID; the message surfaces on next sync.
    return {};
  }

  // ---- Connection ----

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const imapConfig = await this.getImapConfig();
      const imapResult = await imapTestConnection(imapConfig);

      // Also test SMTP connectivity
      try {
        const smtpConfig = await this.getSmtpConfig();
        const smtpResult = await smtpTestConnection(smtpConfig);
        if (!smtpResult.success) {
          return {
            success: false,
            message: `IMAP OK, but SMTP failed: ${smtpResult.message}`,
          };
        }
      } catch (err) {
        return {
          success: false,
          message: `IMAP OK, but SMTP failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      return { success: true, message: `Connected: ${imapResult}` };
    } catch (err) {
      return {
        success: false,
        message: `IMAP connection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async getProfile(): Promise<{ email: string; name?: string }> {
    const account = await this.getAccount();
    return {
      email: account.email,
      name: account.display_name ?? undefined,
    };
  }

  // ---- Helpers ----

  /**
   * Resolve the message IDs a thread-level action should operate on.
   *
   * Callers throughout the UI invoke archive/trash/move with an empty
   * messageIds array, because the Gmail provider ignores the argument entirely
   * and acts on the thread. IMAP has no thread concept and needs UIDs, so an
   * empty array previously produced an empty folder grouping, no IMAP command,
   * and a silent success — leaving the message on the server while the local
   * database recorded it as archived. Fall back to the thread's stored messages
   * so thread-level actions reach the server.
   */
  private async resolveMessageIds(
    threadId: string,
    messageIds: string[],
  ): Promise<string[]> {
    if (messageIds.length > 0) return messageIds;
    if (!threadId) return [];

    const messages = await getMessagesForThread(this.accountId, threadId);
    return messages.map((m) => m.id);
  }

  /**
   * Parse IMAP message IDs and group UIDs by folder.
   * Message ID format: imap-{accountId}-{folder}-{uid}
   * Since accountId can contain hyphens, we strip the known prefix
   * "imap-{this.accountId}-" and then parse the remaining "{folder}-{uid}".
   */
  private groupByFolder(messageIds: string[]): Map<string, number[]> {
    const grouped = new Map<string, number[]>();
    const prefix = `imap-${this.accountId}-`;

    for (const messageId of messageIds) {
      const { folder, uid } = this.parseImapMessageId(messageId, prefix);

      if (uid === null || !folder) {
        console.warn(`Skipping invalid IMAP message ID: ${messageId}`);
        continue;
      }

      const existing = grouped.get(folder);
      if (existing) {
        existing.push(uid);
      } else {
        grouped.set(folder, [uid]);
      }
    }

    return grouped;
  }

  /**
   * Parse an IMAP message ID into folder and uid.
   * Returns { folder, uid } or { folder: null, uid: null } if invalid.
   */
  private parseImapMessageId(
    messageId: string,
    prefix?: string,
  ): { folder: string | null; uid: number | null } {
    const p = prefix ?? `imap-${this.accountId}-`;

    if (!messageId.startsWith(p)) {
      return { folder: null, uid: null };
    }

    // After stripping prefix, remainder is "{folder}-{uid}"
    const remainder = messageId.slice(p.length);
    const lastDash = remainder.lastIndexOf("-");
    if (lastDash === -1) {
      return { folder: null, uid: null };
    }

    const folder = remainder.slice(0, lastDash);
    const uid = parseInt(remainder.slice(lastDash + 1), 10);

    if (!folder || isNaN(uid)) {
      return { folder: null, uid: null };
    }

    return { folder, uid };
  }
}
