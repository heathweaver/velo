/**
 * Web-only admin API for agent access: mint, list and revoke the passphrases an
 * agent uses to reach the MCP endpoint, and read the audit trail of what they did.
 */

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export type AgentScope = "read" | "read_send";

export interface AgentPassphrase {
  id: string;
  label: string;
  hint: string;
  scope: AgentScope;
  blockDestructive: boolean;
  mailboxIds: string[];
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  status: "active" | "expired" | "revoked";
}

export interface NewAgentPassphrase {
  label: string;
  scope: AgentScope;
  blockDestructive: boolean;
  mailboxIds: string[];
  expiresInSeconds: number;
}

export interface MintedPassphrase {
  id: string;
  passphrase: string;
  expiresAt: number;
}

export interface AgentAuditEntry {
  id: number;
  passphraseId: string;
  label: string | null;
  at: number;
  tool: string;
  mailboxId: string | null;
  outcome: "ok" | "denied" | "error";
  detail: string;
}

async function req<T>(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let message = `Request failed (${resp.status})`;
    try {
      const data = await resp.json();
      if (data?.error) message = data.error;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function listAgentPassphrases(): Promise<AgentPassphrase[]> {
  return req("/api/admin/agent-access/passphrases", "GET");
}

export function mintAgentPassphrase(input: NewAgentPassphrase): Promise<MintedPassphrase> {
  return req("/api/admin/agent-access/passphrases", "POST", input);
}

export function revokeAgentPassphrase(id: string): Promise<void> {
  return req(`/api/admin/agent-access/passphrases/${encodeURIComponent(id)}`, "DELETE");
}

export function listAgentAudit(limit = 50): Promise<AgentAuditEntry[]> {
  return req(`/api/admin/agent-access/audit?limit=${limit}`, "GET");
}

/** Where an agent connects: the MCP endpoint on this same host. */
export function mcpUrl(): string {
  const base = API_BASE || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/mcp`;
}
