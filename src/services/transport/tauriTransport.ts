/**
 * Desktop transport — preserves the current behaviour exactly: commands go over
 * Tauri IPC (`invoke`), SQL goes through the Tauri SQL plugin's SQLite database.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import type { Transport, ExecuteResult } from "./types";

let dbPromise: Promise<Database> | null = null;

function db(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:velo.db").then(async (database) => {
      // journal_mode is persisted in the database file, so this applies to every
      // connection in the plugin's pool: readers stop blocking the writer.
      await database.execute("PRAGMA journal_mode=WAL");
      return database;
    });
  }
  return dbPromise;
}

export const tauriTransport: Transport = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
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
