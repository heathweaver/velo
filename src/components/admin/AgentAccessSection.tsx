import { useCallback, useEffect, useState } from "react";
import type { Mailbox } from "../../services/auth/authService";
import {
  listAgentAudit,
  listAgentPassphrases,
  mcpUrl,
  mintAgentPassphrase,
  revokeAgentPassphrase,
  type AgentAuditEntry,
  type AgentPassphrase,
  type AgentScope,
  type MintedPassphrase,
} from "../../services/web/agentAccessService";

const LIFETIMES: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
];

function when(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

/**
 * Give an agent its own passphrase: which mailboxes it may use, whether it can
 * also send and organise mail, whether permanent deletion is blocked, and when
 * it stops working. The passphrase is shown once, here, and never again.
 */
export function AgentAccessSection({ mailboxes }: { mailboxes: Mailbox[] }) {
  const [passphrases, setPassphrases] = useState<AgentPassphrase[]>([]);
  const [audit, setAudit] = useState<AgentAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([listAgentPassphrases(), listAgentAudit()]);
      setPassphrases(p);
      setAudit(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load agent access");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const emailFor = (id: string) => mailboxes.find((m) => m.id === id)?.email ?? "removed mailbox";
  const active = passphrases.filter((p) => p.status === "active");

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-text-primary uppercase tracking-wide">Agent access</h2>
      <p className="text-xs text-text-tertiary">
        Give an agent a passphrase for the mailboxes you choose. It reaches Velo at{" "}
        <code className="font-mono">{mcpUrl()}</code> and stops working when it expires or you revoke it. Your own
        sign-in is never shared with an agent.
      </p>
      {error && <div className="text-sm text-danger">{error}</div>}

      <MintForm mailboxes={mailboxes} onMinted={refresh} />

      <div className="space-y-2">
        <div className="text-xs font-medium text-text-secondary">Active passphrases</div>
        {active.length === 0 && <div className="text-xs text-text-tertiary">None yet.</div>}
        {active.map((p) => (
          <div key={p.id} className="rounded-lg border border-border-secondary p-3 flex items-start justify-between gap-3">
            <div className="text-sm text-text-primary space-y-0.5">
              <div className="font-medium">
                {p.label} <span className="font-mono text-xs text-text-tertiary">{p.hint}</span>
              </div>
              <div className="text-xs text-text-secondary">
                {p.scope === "read" ? "Read only" : "Read and send"}
                {p.scope === "read_send" && (p.blockDestructive ? " · deleting blocked" : " · can delete")}
                {" · "}
                {p.mailboxIds.map(emailFor).join(", ")}
              </div>
              <div className="text-xs text-text-tertiary">
                Expires {when(p.expiresAt)}
                {p.lastUsedAt ? ` · last used ${when(p.lastUsedAt)}` : " · not used yet"}
              </div>
            </div>
            <button
              onClick={async () => {
                try {
                  await revokeAgentPassphrase(p.id);
                  refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not revoke");
                }
              }}
              className="px-3 py-1.5 rounded border border-border-secondary text-sm text-danger hover:bg-bg-hover"
            >
              Revoke
            </button>
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-text-secondary">Recent agent activity</div>
        {audit.length === 0 && <div className="text-xs text-text-tertiary">Nothing yet.</div>}
        {audit.slice(0, 20).map((a) => (
          <div key={a.id} className="text-xs text-text-secondary font-mono">
            {when(a.at)} · {a.label ?? "deleted passphrase"} · {a.tool}
            {a.mailboxId ? ` · ${emailFor(a.mailboxId)}` : ""} · {a.outcome}
            {a.detail ? ` · ${a.detail}` : ""}
          </div>
        ))}
      </div>
    </section>
  );
}

function MintForm({ mailboxes, onMinted }: { mailboxes: Mailbox[]; onMinted: () => void }) {
  const [label, setLabel] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [scope, setScope] = useState<AgentScope>("read");
  const [blockDestructive, setBlockDestructive] = useState(true);
  const [seconds, setSeconds] = useState(LIFETIMES[1]!.seconds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedPassphrase | null>(null);

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const result = await mintAgentPassphrase({
        label,
        scope,
        blockDestructive: scope === "read" ? true : blockDestructive,
        mailboxIds: chosen,
        expiresInSeconds: seconds,
      });
      setMinted(result);
      setLabel("");
      setChosen([]);
      onMinted();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not create the passphrase");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={submit} className="rounded-lg border border-border-secondary p-3 space-y-3">
        <input
          placeholder="Agent name (e.g. Inbox triage)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full px-2 py-1.5 rounded bg-bg-secondary border border-border-secondary text-sm text-text-primary outline-none"
        />
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-text-secondary">Mailboxes it can use</legend>
          {mailboxes.length === 0 && <div className="text-xs text-text-tertiary">Add a mailbox above first.</div>}
          {mailboxes.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" checked={chosen.includes(m.id)} onChange={() => toggle(m.id)} />
              {m.email}
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-text-secondary">What it can do</legend>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="radio" name="agent-scope" checked={scope === "read"} onChange={() => setScope("read")} />
            Read only
          </label>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name="agent-scope"
              checked={scope === "read_send"}
              onChange={() => setScope("read_send")}
            />
            Read, send, mark and move
          </label>
          <label
            className={`flex items-center gap-2 text-sm pl-6 ${scope === "read" ? "text-text-tertiary" : "text-text-primary"}`}
          >
            <input
              type="checkbox"
              disabled={scope === "read"}
              checked={scope === "read" ? true : blockDestructive}
              onChange={(e) => setBlockDestructive(e.target.checked)}
            />
            Block permanent deletion
          </label>
        </fieldset>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          Expires after
          <select
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
            className="px-2 py-1.5 rounded bg-bg-secondary border border-border-secondary text-sm"
          >
            {LIFETIMES.map((l) => (
              <option key={l.seconds} value={l.seconds}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        {err && <div className="text-sm text-danger">{err}</div>}
        <button
          type="submit"
          disabled={busy || !label.trim() || chosen.length === 0}
          className="px-3 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent-hover disabled:opacity-50"
        >
          Create passphrase
        </button>
      </form>

      {minted && (
        <div role="status" className="rounded-lg border border-border-secondary p-3 space-y-2">
          <div className="text-sm text-text-primary">
            Copy this passphrase now. It is shown only once; Velo keeps no readable copy.
          </div>
          <code className="block break-all font-mono text-xs bg-bg-secondary rounded p-2">{minted.passphrase}</code>
          <div className="text-xs text-text-tertiary">
            Send it as <code className="font-mono">Authorization: Bearer …</code> to{" "}
            <code className="font-mono">{mcpUrl()}</code>. Expires {when(minted.expiresAt)}.
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(minted.passphrase)}
              className="px-3 py-1.5 rounded border border-border-secondary text-sm hover:bg-bg-hover"
            >
              Copy
            </button>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className="px-3 py-1.5 rounded border border-border-secondary text-sm hover:bg-bg-hover"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
