/**
 * Deno Desktop transport — direct in-process SQLite database access via node:sqlite
 * and native TypeScript command handling.
 */

import { DatabaseSync } from "node:sqlite";
import type { Transport, ExecuteResult } from "./types";

let dbInstance: DatabaseSync | null = null;
const commandHandlers = new Map<string, (args?: Record<string, unknown>) => Promise<unknown> | unknown>();

export function registerDenoCommandHandler(
  name: string,
  handler: (args?: Record<string, unknown>) => Promise<unknown> | unknown,
): void {
  commandHandlers.set(name, handler);
}

export function getDenoDb(dbPath = "velo.db"): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(dbPath);
    // WAL mode for fast concurrent read/write
    dbInstance.exec("PRAGMA journal_mode = WAL;");
    dbInstance.exec("PRAGMA foreign_keys = ON;");
  }
  return dbInstance;
}

export function setDenoDb(db: DatabaseSync): void {
  dbInstance = db;
}

/**
 * Normalizes SQL statements by replacing numbered parameter placeholders ($1, $2...)
 * with standard SQLite positional parameter placeholders (?).
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\$\d+/g, "?");
}

export const denoTransport: Transport = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const handler = commandHandlers.get(command);
    if (handler) {
      return (await handler(args)) as T;
    }
    console.warn(`[denoTransport] No handler registered for command: ${command}`);
    return undefined as unknown as T;
  },

  async select<T>(query: string, params: unknown[] = []): Promise<T> {
    const db = getDenoDb();
    const normalized = normalizeSql(query);
    const stmt = db.prepare(normalized);
    const rows = stmt.all(...params);
    return rows as unknown as T;
  },

  async execute(query: string, params: unknown[] = []): Promise<ExecuteResult> {
    const db = getDenoDb();
    const normalized = normalizeSql(query);
    if (params.length === 0) {
      // Direct multi-statement or statement execution
      db.exec(normalized);
      return { rowsAffected: 0 };
    }
    const stmt = db.prepare(normalized);
    const result = stmt.run(...params);
    return {
      rowsAffected: Number(result.changes),
      lastInsertId:
        result.lastInsertRowid !== undefined
          ? Number(result.lastInsertRowid)
          : undefined,
    };
  },
};
