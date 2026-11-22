/**
 * Live, cache-free mail API for the light web client. Every call goes to
 * velo-server, which talks to IMAP. Nothing is synced into the browser.
 */

export interface Mailbox {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Folder {
  path: string;
  name: string;
  specialUse: string | null;
  exists: number;
  unseen: number;
}

export interface Msg {
  uid: number;
  folder: string;
  fromName: string | null;
  fromAddress: string | null;
  toAddresses: string | null;
  subject: string | null;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  bodyHtml: string | null;
  bodyText: string | null;
  snippet: string | null;
  hasAttachmentsHint?: boolean;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    let message = `Request failed (${resp.status})`;
    try {
      const j = (await resp.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return (await resp.json()) as T;
}

export const listMailboxes = () => call<Mailbox[]>("/mailboxes");

export const listFolders = (mailboxId: string) =>
  call<Folder[]>("/imap/list_folders", { mailboxId });

/** Newest-first page of message headers. `before` is the lowest uid already shown. */
export async function listMessages(
  mailboxId: string,
  folder: string,
  before: number | null,
  pageSize = 50,
): Promise<{ messages: Msg[]; lowestUid: number | null; more: boolean }> {
  const all = await call<number[]>("/imap/search_all_uids", { mailboxId, folder });
  const sorted = [...all].sort((a, b) => b - a);
  const rest = before == null ? sorted : sorted.filter((u) => u < before);
  const page = rest.slice(0, pageSize);
  if (page.length === 0) return { messages: [], lowestUid: before, more: false };
  const messages = await call<Msg[]>("/imap/fetch_messages", {
    mailboxId,
    folder,
    uids: page,
    headersOnly: true,
  });
  messages.sort((a, b) => b.date - a.date);
  return { messages, lowestUid: page[page.length - 1] ?? null, more: rest.length > page.length };
}

export const fetchBody = (mailboxId: string, folder: string, uid: number) =>
  call<Msg>("/imap/fetch_message_body", { mailboxId, folder, uid });

export const setFlag = (
  mailboxId: string,
  folder: string,
  uid: number,
  flag: "\\Seen" | "\\Flagged",
  add: boolean,
) =>
  call<null>("/imap/set_flags", { mailboxId, folder, uids: [uid], flags: [flag], add });

export const moveMessage = (mailboxId: string, folder: string, uid: number, destination: string) =>
  call<null>("/imap/move_messages", { mailboxId, folder, uids: [uid], destination });

export const deleteMessage = (mailboxId: string, folder: string, uid: number) =>
  call<null>("/imap/delete_messages", { mailboxId, folder, uids: [uid] });
