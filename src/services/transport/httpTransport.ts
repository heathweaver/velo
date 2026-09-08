/**
 * Web transport — talks to velo-server over HTTP. Commands map to /api/* routes;
 * SQL goes through the server-side SQL gateway (/api/db/select|execute).
 *
 * Requests send credentials (the session cookie) so the server can enforce
 * per-user access (admin sees all; members see only their own accounts).
 * A 502 with `{ error }` from the server is turned back into a rejected promise,
 * matching how `invoke()` rejects on the desktop.
 */

import type { Transport, ExecuteResult } from "./types";
import { COMMAND_ROUTES } from "./commandRoutes";

/** Base URL for the API. Empty string = same origin (server serves the SPA). */
const API_BASE =
  ((typeof import.meta !== "undefined" &&
    (import.meta as unknown as { env?: { VITE_API_BASE?: string } })?.env
      ?.VITE_API_BASE) as string | undefined) ?? "";

/**
 * IMAP/SMTP commands carry a `config` object. On the web, that config has a
 * `mailboxId` instead of real credentials — lift it to the request root where
 * the server expects it, so the server resolves and authorizes the mailbox.
 */
function hoistMailboxId(args: Record<string, unknown>): Record<string, unknown> {
  const config = args["config"] as { mailboxId?: string } | undefined;
  if (config && typeof config.mailboxId === "string") {
    return { ...args, mailboxId: config.mailboxId };
  }
  return args;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body ?? {}),
  });

  if (!resp.ok) {
    let message = `Request failed (${resp.status})`;
    try {
      const data = await resp.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch {
      // non-JSON error body; keep the status message
    }
    throw new Error(message);
  }

  // 204 No Content → undefined (mirrors the Tauri void commands)
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const httpTransport: Transport = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const route = COMMAND_ROUTES[command];
    if (!route) {
      return Promise.reject(
        new Error(`Command "${command}" is not available in the web app`),
      );
    }
    return postJson<T>(route, hoistMailboxId(args ?? {}));
  },

  select<T>(query: string, params: unknown[] = []): Promise<T> {
    return postJson<T>("/api/db/select", { query, params });
  },

  execute(query: string, params: unknown[] = []): Promise<ExecuteResult> {
    return postJson<ExecuteResult>("/api/db/execute", { query, params });
  },
};
