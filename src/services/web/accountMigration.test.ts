import { describe, it, expect, beforeEach, vi } from "vitest";

const fetchMe = vi.fn();
const listAllMailboxes = vi.fn();
const createMailbox = vi.fn();
const getAllAccounts = vi.fn();

vi.mock("../auth/authService", () => ({
  fetchMe: () => fetchMe(),
  listAllMailboxes: () => listAllMailboxes(),
  createMailbox: (i: unknown) => createMailbox(i),
}));
vi.mock("../../utils/crypto", () => ({ isEncrypted: (v: string) => v.includes(":") }));
vi.mock("../db/accounts", () => ({ getAllAccounts: () => getAllAccounts() }));

import { migrateBrowserAccountsToServer } from "./accountMigration";

const account = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  email: "heath.weaver@realdigit.co",
  display_name: "Heath",
  provider: "imap",
  auth_method: "password",
  imap_host: "imap.example.com",
  imap_port: 993,
  imap_security: "ssl",
  smtp_host: "smtp.example.com",
  smtp_port: 465,
  smtp_security: "ssl",
  imap_username: "heath",
  imap_password: "secret",
  accept_invalid_certs: 0,
  mailbox_id: null,
  ...over,
});

describe("migrateBrowserAccountsToServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMe.mockResolvedValue({ id: "u1", role: "admin" });
    listAllMailboxes.mockResolvedValue([]);
    createMailbox.mockResolvedValue({ id: "m1" });
  });

  it("uploads a browser-only account with its decrypted password and server security names", async () => {
    getAllAccounts.mockResolvedValue([account()]);
    const moved = await migrateBrowserAccountsToServer();
    expect(moved).toEqual(["heath.weaver@realdigit.co"]);
    expect(createMailbox).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "u1",
        password: "secret",
        imapSecurity: "tls",
        smtpSecurity: "tls",
        username: "heath",
      }),
    );
  });

  it("skips server-backed, already-present, OAuth and passwordless accounts", async () => {
    listAllMailboxes.mockResolvedValue([{ email: "Dup@Example.com" }]);
    getAllAccounts.mockResolvedValue([
      account({ id: "mbx-1", mailbox_id: "1" }),
      account({ id: "a2", email: "dup@example.com" }),
      account({ id: "a3", provider: "gmail_api" }),
      account({ id: "a4", imap_password: "" }),
    ]);
    expect(await migrateBrowserAccountsToServer()).toEqual([]);
    expect(createMailbox).not.toHaveBeenCalled();
  });

  it("does not upload a password it could not decrypt", async () => {
    getAllAccounts.mockResolvedValue([account({ imap_password: "AAAAAAAAAAAAAAAA:Zm9v" })]);
    expect(await migrateBrowserAccountsToServer()).toEqual([]);
    expect(createMailbox).not.toHaveBeenCalled();
  });

  it("does nothing for non-admins", async () => {
    fetchMe.mockResolvedValue({ id: "u2", role: "member" });
    getAllAccounts.mockResolvedValue([account()]);
    expect(await migrateBrowserAccountsToServer()).toEqual([]);
    expect(createMailbox).not.toHaveBeenCalled();
  });

  it("keeps going when one upload fails", async () => {
    createMailbox.mockRejectedValueOnce(new Error("boom"));
    getAllAccounts.mockResolvedValue([account(), account({ id: "a2", email: "b@x.com" })]);
    expect(await migrateBrowserAccountsToServer()).toEqual(["b@x.com"]);
  });
});
