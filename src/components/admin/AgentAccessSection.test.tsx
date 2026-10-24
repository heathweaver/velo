import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentAccessSection } from "./AgentAccessSection";
import type { Mailbox } from "../../services/auth/authService";

const svc = vi.hoisted(() => ({
  listAgentPassphrases: vi.fn(),
  listAgentAudit: vi.fn(),
  mintAgentPassphrase: vi.fn(),
  revokeAgentPassphrase: vi.fn(),
  mcpUrl: () => "https://velo.example/mcp",
}));
vi.mock("../../services/web/agentAccessService", () => svc);

const mailbox = (id: string, email: string): Mailbox => ({
  id,
  ownerUserId: "u1",
  email,
  displayName: null,
  imapHost: "",
  imapPort: 993,
  imapSecurity: "tls",
  smtpHost: "",
  smtpPort: 465,
  smtpSecurity: "tls",
  username: null,
  acceptInvalidCerts: false,
});

const mailboxes = [mailbox("m1", "me@example.com"), mailbox("m2", "sales@example.com")];

beforeEach(() => {
  vi.clearAllMocks();
  svc.listAgentPassphrases.mockResolvedValue([]);
  svc.listAgentAudit.mockResolvedValue([]);
});

describe("AgentAccessSection", () => {
  it("mints a read-only passphrase for only the ticked mailboxes and shows it once", async () => {
    svc.mintAgentPassphrase.mockResolvedValue({ id: "p1", passphrase: "vpk_secret", expiresAt: 2_000_000_000 });
    render(<AgentAccessSection mailboxes={mailboxes} />);

    fireEvent.change(screen.getByPlaceholderText(/agent name/i), { target: { value: "Triage" } });
    fireEvent.click(screen.getByLabelText("sales@example.com"));
    fireEvent.click(screen.getByRole("button", { name: /create passphrase/i }));

    await waitFor(() =>
      expect(svc.mintAgentPassphrase).toHaveBeenCalledWith({
        label: "Triage",
        scope: "read",
        blockDestructive: true,
        mailboxIds: ["m2"],
        expiresInSeconds: 86400,
      }),
    );
    expect(await screen.findByText("vpk_secret")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("vpk_secret")).not.toBeInTheDocument();
  });

  it("keeps deletion blocked by default and lets it be unblocked only for read-and-send", async () => {
    svc.mintAgentPassphrase.mockResolvedValue({ id: "p1", passphrase: "vpk_x", expiresAt: 2_000_000_000 });
    render(<AgentAccessSection mailboxes={mailboxes} />);

    const block = screen.getByLabelText(/block permanent deletion/i);
    expect(block).toBeDisabled();
    expect(block).toBeChecked();

    fireEvent.click(screen.getByLabelText(/read, send, mark and move/i));
    expect(block).toBeEnabled();
    fireEvent.click(block);
    fireEvent.change(screen.getByPlaceholderText(/agent name/i), { target: { value: "Sender" } });
    fireEvent.click(screen.getByLabelText("me@example.com"));
    fireEvent.click(screen.getByRole("button", { name: /create passphrase/i }));

    await waitFor(() =>
      expect(svc.mintAgentPassphrase).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "read_send", blockDestructive: false, mailboxIds: ["m1"] }),
      ),
    );
  });

  it("will not create a passphrase with no name or no mailbox", () => {
    render(<AgentAccessSection mailboxes={mailboxes} />);
    expect(screen.getByRole("button", { name: /create passphrase/i })).toBeDisabled();
  });

  it("lists active passphrases and revokes one", async () => {
    svc.listAgentPassphrases.mockResolvedValue([
      {
        id: "p1", label: "Triage", hint: "…ab12", scope: "read", blockDestructive: true, mailboxIds: ["m1"],
        createdBy: "me", createdAt: 1, expiresAt: 4_000_000_000, revokedAt: null, lastUsedAt: null, status: "active",
      },
      {
        id: "p2", label: "Old", hint: "…ffff", scope: "read", blockDestructive: true, mailboxIds: ["m1"],
        createdBy: "me", createdAt: 1, expiresAt: 5, revokedAt: null, lastUsedAt: null, status: "expired",
      },
    ]);
    svc.revokeAgentPassphrase.mockResolvedValue(undefined);
    render(<AgentAccessSection mailboxes={mailboxes} />);

    expect(await screen.findByText("Triage")).toBeInTheDocument();
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(svc.revokeAgentPassphrase).toHaveBeenCalledWith("p1"));
  });

  it("shows what agents did", async () => {
    svc.listAgentAudit.mockResolvedValue([
      { id: 1, passphraseId: "p1", label: "Triage", at: 1_700_000_000, tool: "read_message", mailboxId: "m1", outcome: "ok", detail: "INBOX uid 4" },
      { id: 2, passphraseId: "p1", label: "Triage", at: 1_700_000_100, tool: "delete_messages", mailboxId: null, outcome: "denied", detail: "Permanent deletion is blocked for this passphrase" },
    ]);
    render(<AgentAccessSection mailboxes={mailboxes} />);
    expect(await screen.findByText(/read_message/)).toBeInTheDocument();
    expect(screen.getByText(/delete_messages.*denied/)).toBeInTheDocument();
  });
});
