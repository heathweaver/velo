import { getTransport, type ExecuteResult } from "../transport";

/**
 * Minimal database surface used across the db service layer. Backed by the
 * active transport: the Tauri SQL plugin on desktop, or the velo-server SQL
 * gateway over HTTP on the web. Only `select`/`execute` are used anywhere.
 */
export interface Db {
  select<T>(query: string, params?: unknown[]): Promise<T>;
  execute(query: string, params?: unknown[]): Promise<ExecuteResult>;
}

const db: Db = {
  select: (query, params = []) => getTransport().select(query, params),
  execute: (query, params = []) => getTransport().execute(query, params),
};

export async function getDb(): Promise<Db> {
  return db;
}

/**
 * Build a dynamic SQL UPDATE statement from a set of field updates.
 * Returns null if no fields to update.
 */
export function buildDynamicUpdate(
  table: string,
  idColumn: string,
  id: unknown,
  fields: [string, unknown][],
): { sql: string; params: unknown[] } | null {
  if (fields.length === 0) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [column, value] of fields) {
    sets.push(`${column} = $${idx++}`);
    params.push(value);
  }

  params.push(id);
  return {
    sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${idColumn} = $${idx}`,
    params,
  };
}

/**
 * Simple async mutex that serialises the blocks below. SQLite allows only one
 * writer at a time, and overlapping write batches from sync, categorisation and
 * attachment caching otherwise contend for the write lock.
 */
let txQueue: Promise<void> = Promise.resolve();

export async function withTransaction(fn: (db: Db) => Promise<void>): Promise<void> {
  // Queue this transaction behind any currently-running one.
  // This serialises all transactions without blocking non-transactional reads.
  const prev = txQueue;
  let resolve!: () => void;
  txQueue = new Promise<void>((r) => {
    resolve = r;
  });

  try {
    await prev; // wait for previous transaction to finish
  } catch {
    // previous transaction errored — that's fine, we can still proceed
  }

  const database = await getDb();
  try {
    // No explicit BEGIN/COMMIT here. Neither transport can guarantee that
    // consecutive execute() calls reach the same SQLite connection: the Tauri
    // plugin hands out connections from a sqlx pool, and the HTTP transport
    // sends each statement as its own request. A BEGIN could take the write lock
    // on one connection while its COMMIT ran on another, stranding an open write
    // transaction so that every later write failed with SQLITE_BUSY ("database
    // is locked"). The txQueue above already serialises these blocks.
    await fn(database);
  } finally {
    resolve(); // always unblock the next queued transaction
  }
}

/**
 * Execute a SELECT query and return the first result or null.
 */
export async function selectFirstBy<T>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const db = await getDb();
  const rows = await db.select<T[]>(query, params);
  return rows[0] ?? null;
}

/**
 * Execute a COUNT(*) query and return whether any rows exist.
 */
export async function existsBy(
  query: string,
  params: unknown[] = [],
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(query, params);
  return (rows[0]?.count ?? 0) > 0;
}

/**
 * Convert a boolean to SQLite integer (0 or 1).
 */
export function boolToInt(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}
