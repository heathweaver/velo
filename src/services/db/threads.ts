import { getDb } from "./connection";

export interface DbThread {
  id: string;
  account_id: string;
  subject: string | null;
  snippet: string | null;
  last_message_at: number | null;
  message_count: number;
  is_read: number;
  is_starred: number;
  is_important: number;
  has_attachments: number;
  is_snoozed: number;
  snooze_until: number | null;
  is_pinned: number;
  is_muted: number;
  from_name: string | null;
  from_address: string | null;
}

export async function getThreadsForAccount(
  accountId: string,
  labelId?: string,
  limit = 50,
  offset = 0,
): Promise<DbThread[]> {
  const db = await getDb();
  if (labelId) {
    return db.select<DbThread[]>(
      `SELECT t.*, m.from_name, m.from_address FROM threads t
       INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
       LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
         AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
       WHERE t.account_id = $1 AND tl.label_id = $2
       GROUP BY t.account_id, t.id
       ORDER BY t.is_pinned DESC, t.last_message_at DESC
       LIMIT $3 OFFSET $4`,
      [accountId, labelId, limit, offset],
    );
  }
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1
     ORDER BY t.is_pinned DESC, t.last_message_at DESC LIMIT $2 OFFSET $3`,
    [accountId, limit, offset],
  );
}

/**
 * Load threads by id, ignoring which folder or label they live in.
 *
 * Search results are the one view that must escape the current folder: a hit in
 * Archive is still a hit when you searched from the Inbox. The list otherwise
 * only holds the threads of the folder being viewed, so intersecting search
 * results with it silently hides everything filed elsewhere.
 */
export async function getThreadsByIds(
  ids: string[],
  accountId?: string,
  limit = 200,
): Promise<DbThread[]> {
  if (ids.length === 0) return [];
  const db = await getDb();

  const capped = ids.slice(0, limit);
  const placeholders = capped.map((_, i) => `$${i + 1}`).join(", ");
  const params: unknown[] = [...capped];
  let accountClause = "";
  if (accountId) {
    params.push(accountId);
    accountClause = ` AND t.account_id = $${params.length}`;
  }

  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.id IN (${placeholders})${accountClause}
     ORDER BY t.is_pinned DESC, t.last_message_at DESC`,
    params,
  );
}

export async function getThreadsForCategory(
  accountId: string,
  category: string,
  limit = 50,
  offset = 0,
): Promise<DbThread[]> {
  const db = await getDb();
  if (category === "Primary") {
    // Primary includes threads with NULL category (uncategorized)
    return db.select<DbThread[]>(
      `SELECT t.*, m.from_name, m.from_address FROM threads t
       INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
       LEFT JOIN thread_categories tc ON tc.account_id = t.account_id AND tc.thread_id = t.id
       LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
         AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
       WHERE t.account_id = $1 AND tl.label_id = 'INBOX' AND (tc.category IS NULL OR tc.category = 'Primary')
       GROUP BY t.account_id, t.id
       ORDER BY t.is_pinned DESC, t.last_message_at DESC
       LIMIT $2 OFFSET $3`,
      [accountId, limit, offset],
    );
  }
  return db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
     INNER JOIN thread_categories tc ON tc.account_id = t.account_id AND tc.thread_id = t.id
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1 AND tl.label_id = 'INBOX' AND tc.category = $2
     GROUP BY t.account_id, t.id
     ORDER BY t.is_pinned DESC, t.last_message_at DESC
     LIMIT $3 OFFSET $4`,
    [accountId, category, limit, offset],
  );
}

export async function upsertThread(thread: {
  id: string;
  accountId: string;
  subject: string | null;
  snippet: string | null;
  lastMessageAt: number | null;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  hasAttachments: boolean;
}): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO threads (id, account_id, subject, snippet, last_message_at, message_count, is_read, is_starred, is_important, has_attachments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT(account_id, id) DO UPDATE SET
       subject = $3, snippet = COALESCE(NULLIF($4, ''), snippet), last_message_at = $5, message_count = $6,
       is_read = $7, is_starred = $8, is_important = $9, has_attachments = $10`,
    [
      thread.id,
      thread.accountId,
      thread.subject,
      thread.snippet,
      thread.lastMessageAt,
      thread.messageCount,
      thread.isRead ? 1 : 0,
      thread.isStarred ? 1 : 0,
      thread.isImportant ? 1 : 0,
      thread.hasAttachments ? 1 : 0,
    ],
  );
}

export async function setThreadLabels(
  accountId: string,
  threadId: string,
  labelIds: string[],
): Promise<void> {
  const db = await getDb();
  // Remove existing labels
  await db.execute(
    "DELETE FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  // Insert new labels
  for (const labelId of labelIds) {
    await db.execute(
      "INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id) VALUES ($1, $2, $3)",
      [accountId, threadId, labelId],
    );
  }
}

export async function getThreadLabelIds(
  accountId: string,
  threadId: string,
): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ label_id: string }[]>(
    "SELECT label_id FROM thread_labels WHERE account_id = $1 AND thread_id = $2",
    [accountId, threadId],
  );
  return rows.map((r) => r.label_id);
}

/** Map key for a thread across accounts (thread ids are not globally unique). */
export function threadKey(accountId: string, threadId: string): string {
  return `${accountId}\u0000${threadId}`;
}

export interface ThreadRef {
  accountId: string;
  threadId: string;
}

/** SQLite's default variable limit is 999; stay well under it per statement. */
const BATCH_IN_LIMIT = 500;

/** Group refs by account and split each group into IN-list sized chunks. */
function chunkRefsByAccount(refs: ThreadRef[]): { accountId: string; threadIds: string[] }[] {
  const byAccount = new Map<string, Set<string>>();
  for (const { accountId, threadId } of refs) {
    let ids = byAccount.get(accountId);
    if (!ids) {
      ids = new Set();
      byAccount.set(accountId, ids);
    }
    ids.add(threadId);
  }
  const chunks: { accountId: string; threadIds: string[] }[] = [];
  for (const [accountId, ids] of byAccount) {
    const all = [...ids];
    for (let i = 0; i < all.length; i += BATCH_IN_LIMIT) {
      chunks.push({ accountId, threadIds: all.slice(i, i + BATCH_IN_LIMIT) });
    }
  }
  return chunks;
}

/**
 * Label ids for many threads in one query per account.
 *
 * The thread list used to call getThreadLabelIds once per row — 50 IPC round
 * trips into SQLite for every page, on every folder switch and after every
 * sync. Keys are threadKey(accountId, threadId); threads with no labels map to
 * an empty array.
 */
export async function getThreadLabelIdsBatch(refs: ThreadRef[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const { accountId, threadId } of refs) result.set(threadKey(accountId, threadId), []);
  if (refs.length === 0) return result;

  const db = await getDb();
  for (const { accountId, threadIds } of chunkRefsByAccount(refs)) {
    const placeholders = threadIds.map((_, i) => `$${i + 2}`).join(", ");
    const rows = await db.select<{ thread_id: string; label_id: string }[]>(
      `SELECT thread_id, label_id FROM thread_labels WHERE account_id = $1 AND thread_id IN (${placeholders})`,
      [accountId, ...threadIds],
    );
    for (const row of rows) {
      result.get(threadKey(accountId, row.thread_id))?.push(row.label_id);
    }
  }
  return result;
}

/**
 * Thread rows for many (account, thread) pairs in one query per account,
 * keyed by threadKey. Rows carry the thread's own columns only — no sender
 * join — which is all the smart-folder list needs from them.
 */
export async function getThreadsByRefs(refs: ThreadRef[]): Promise<Map<string, DbThread>> {
  const result = new Map<string, DbThread>();
  if (refs.length === 0) return result;

  const db = await getDb();
  for (const { accountId, threadIds } of chunkRefsByAccount(refs)) {
    const placeholders = threadIds.map((_, i) => `$${i + 2}`).join(", ");
    const rows = await db.select<DbThread[]>(
      `SELECT * FROM threads WHERE account_id = $1 AND id IN (${placeholders})`,
      [accountId, ...threadIds],
    );
    for (const row of rows) result.set(threadKey(accountId, row.id), row);
  }
  return result;
}

export async function getThreadById(
  accountId: string,
  threadId: string,
): Promise<DbThread | undefined> {
  const db = await getDb();
  const rows = await db.select<DbThread[]>(
    `SELECT t.*, m.from_name, m.from_address FROM threads t
     LEFT JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id
       AND m.date = (SELECT MAX(m2.date) FROM messages m2 WHERE m2.account_id = t.account_id AND m2.thread_id = t.id)
     WHERE t.account_id = $1 AND t.id = $2
     LIMIT 1`,
    [accountId, threadId],
  );
  return rows[0];
}

export async function getThreadCountForAccount(accountId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM threads WHERE account_id = $1",
    [accountId],
  );
  return rows[0]?.count ?? 0;
}

export async function getUnreadInboxCount(): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM threads t
     INNER JOIN thread_labels tl ON tl.account_id = t.account_id AND tl.thread_id = t.id
     WHERE tl.label_id = 'INBOX' AND t.is_read = 0`,
  );
  return rows[0]?.count ?? 0;
}

/**
 * Give a thread a preview line if it has none.
 *
 * Headers-only sync stores IMAP threads without a snippet (there is no body to
 * take one from); the first time a body is loaded, it can supply one. Never
 * overwrites an existing snippet.
 */
export async function fillThreadSnippetIfEmpty(
  accountId: string,
  threadId: string,
  snippet: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET snippet = $1 WHERE account_id = $2 AND id = $3 AND (snippet IS NULL OR snippet = '')",
    [snippet, accountId, threadId],
  );
}

export async function deleteThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM threads WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function deleteAllThreadsForAccount(
  accountId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM threads WHERE account_id = $1",
    [accountId],
  );
}

export async function pinThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_pinned = 1 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function unpinThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_pinned = 0 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function muteThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_muted = 1 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function unmuteThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE threads SET is_muted = 0 WHERE account_id = $1 AND id = $2",
    [accountId, threadId],
  );
}

export async function getMutedThreadIds(
  accountId: string,
): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ id: string }[]>(
    "SELECT id FROM threads WHERE account_id = $1 AND is_muted = 1",
    [accountId],
  );
  return new Set(rows.map((r) => r.id));
}
