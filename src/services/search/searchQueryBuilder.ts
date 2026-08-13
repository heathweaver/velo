import type { ParsedSearchQuery } from "./searchParser";

interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build a parameterized SQL query from a parsed search query.
 * Returns { sql, params } for safe execution.
 */
export function buildSearchQuery(
  parsed: ParsedSearchQuery,
  accountId?: string,
  limit = 50,
  offset = 0,
  /**
   * Count matches instead of listing them.
   *
   * The caller used to reach for the generated SQL and rewrite it with regular
   * expressions — replacing the SELECT, stripping the ORDER BY and LIMIT, and
   * dropping the last parameter. That only held while the statement kept its
   * exact shape, and it silently produced nonsense the moment the shape moved.
   */
  countOnly = false,
): BuiltQuery {
  const params: unknown[] = [];
  let paramIdx = 1;

  const whereClauses: string[] = [];
  let needsFts = false;

  // Base query - we'll add FTS join conditionally
  let fromClause = "FROM messages m";

  // Free text search via FTS5
  if (parsed.freeText) {
    needsFts = true;
    fromClause = "FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid";
    whereClauses.push(`messages_fts MATCH $${paramIdx}`);
    params.push(parsed.freeText);
    paramIdx++;
  }

  // Account filter
  if (accountId) {
    whereClauses.push(`m.account_id = $${paramIdx}`);
    params.push(accountId);
    paramIdx++;
  }

  // from: operator
  if (parsed.from) {
    whereClauses.push(`(m.from_address LIKE '%' || $${paramIdx} || '%' OR m.from_name LIKE '%' || $${paramIdx} || '%')`);
    params.push(parsed.from);
    paramIdx++;
  }

  // to: operator
  if (parsed.to) {
    whereClauses.push(`m.to_addresses LIKE '%' || $${paramIdx} || '%'`);
    params.push(parsed.to);
    paramIdx++;
  }

  // subject: operator
  if (parsed.subject) {
    whereClauses.push(`m.subject LIKE '%' || $${paramIdx} || '%'`);
    params.push(parsed.subject);
    paramIdx++;
  }

  // has:attachment
  if (parsed.hasAttachment) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM attachments a WHERE a.account_id = m.account_id AND a.message_id = m.id)`,
    );
  }

  // is:unread
  if (parsed.isUnread) {
    whereClauses.push(`m.is_read = 0`);
  }

  // is:read
  if (parsed.isRead) {
    whereClauses.push(`m.is_read = 1`);
  }

  // is:starred
  if (parsed.isStarred) {
    whereClauses.push(`m.is_starred = 1`);
  }

  // before: date
  if (parsed.before !== undefined) {
    whereClauses.push(`m.date < $${paramIdx}`);
    params.push(parsed.before);
    paramIdx++;
  }

  // after: date
  if (parsed.after !== undefined) {
    whereClauses.push(`m.date > $${paramIdx}`);
    params.push(parsed.after);
    paramIdx++;
  }

  // label: operator
  if (parsed.label) {
    whereClauses.push(
      `EXISTS (SELECT 1 FROM thread_labels tl JOIN labels l ON l.account_id = tl.account_id AND l.id = tl.label_id WHERE tl.account_id = m.account_id AND tl.thread_id = m.thread_id AND LOWER(l.name) = LOWER($${paramIdx}))`,
    );
    params.push(parsed.label);
    paramIdx++;
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  if (countOnly) {
    return {
      sql: `SELECT COUNT(DISTINCT m.id) as count
  ${fromClause}
  ${whereStr}`,
      params,
    };
  }

  params.push(limit);
  const limitIdx = paramIdx;
  paramIdx++;
  params.push(offset);
  const offsetIdx = paramIdx;

  // Free-text results are ranked per message, so they stay one row per message
  // and are deduplicated by the caller. Everything else is a list of threads:
  // grouping here makes the limit count threads rather than messages, which it
  // did not before — a page of 50 messages collapsed into however many threads
  // those messages happened to belong to, and the rest were simply missing.
  //
  // With exactly one max() aggregate, SQLite takes the bare columns from the row
  // that produced the maximum, so each row describes the thread's newest
  // message — which is what the list shows.
  const sql = needsFts
    ? `SELECT DISTINCT
    m.id as message_id,
    m.account_id,
    m.thread_id,
    m.subject,
    m.from_name,
    m.from_address,
    m.snippet,
    m.date,
    rank
  ${fromClause}
  ${whereStr}
  ORDER BY rank
  LIMIT $${limitIdx} OFFSET $${offsetIdx}`
    : `SELECT
    m.id as message_id,
    m.account_id,
    m.thread_id,
    m.subject,
    m.from_name,
    m.from_address,
    m.snippet,
    MAX(m.date) as date,
    0 as rank
  ${fromClause}
  ${whereStr}
  GROUP BY m.account_id, m.thread_id
  ORDER BY date DESC
  LIMIT $${limitIdx} OFFSET $${offsetIdx}`;

  return { sql, params };
}
