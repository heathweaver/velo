/**
 * Desktop transport — preserves the current behaviour exactly: commands go over
 * Tauri IPC (`invoke`), SQL goes through the Tauri SQL plugin's SQLite database.
 */

import type { Transport, ExecuteResult } from "./types";

interface TauriSqlDb {
  select<T>(query: string, params?: unknown[]): Promise<T>;
  execute(query: string, params?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

let dbPromise: Promise<TauriSqlDb> | null = null;

async function db(): Promise<TauriSqlDb> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      const database = await Database.load("sqlite:velo.db");
      await database.execute("PRAGMA journal_mode=WAL");
      return database;
    })();
  }
  return dbPromise;
}

export const tauriTransport: Transport = {
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(command, args);
  },
  async select<T>(query: string, params: unknown[] = []): Promise<T> {
    return (await db()).select<T>(query, params);
  },
  async execute(query: string, params: unknown[] = []): Promise<ExecuteResult> {
    const result = await (await db()).execute(query, params);
    return {
      rowsAffected: result.rowsAffected,
      lastInsertId:
        typeof result.lastInsertId === "number"
          ? result.lastInsertId
          : undefined,
    };
  },
};
