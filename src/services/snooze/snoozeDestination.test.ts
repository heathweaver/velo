import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockGetAccount = vi.fn();

vi.mock("../db/connection", () => ({
  getDb: () => Promise.resolve({ select: mockSelect }),
}));

vi.mock("../db/accounts", () => ({
  getAccount: (...args: unknown[]) => mockGetAccount(...(args as [])),
}));

const mockCreateFolder = vi.fn(() => Promise.resolve());

vi.mock("../imap/imapConfigBuilder", () => ({
  buildImapConfig: () => ({ host: "imap.example.com" }),
}));

vi.mock("../imap/tauriCommands", () => ({
  imapCreateFolder: (...args: unknown[]) => mockCreateFolder(...(args as [])),
}));

import { resolveSnoozeDestination } from "./snoozeDestination";

function imapAccount() {
  return { id: "acc-1", provider: "imap" };
}

function gmailAccount() {
  return { id: "acc-1", provider: "gmail_api" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSelect.mockResolvedValue([]);
});

describe("resolveSnoozeDestination", () => {
  it("uses an existing Later folder on IMAP", async () => {
    // Spark parks snoozed mail in "Later", so an account that has been through
    // Spark already has one — reusing it keeps a single snooze pile.
    mockGetAccount.mockResolvedValue(imapAccount());
    mockSelect.mockResolvedValue([
      { id: "folder-INBOX.Later", name: "Later", imap_folder_path: "INBOX.Later" },
    ]);

    const destination = await resolveSnoozeDestination("acc-1");

    expect(destination).toEqual({
      kind: "folder",
      folderPath: "INBOX.Later",
      labelId: "folder-INBOX.Later",
    });
  });

  it("prefers Later over Snoozed when both exist", async () => {
    mockGetAccount.mockResolvedValue(imapAccount());
    mockSelect.mockResolvedValue([
      { id: "folder-INBOX.Snoozed", name: "Snoozed", imap_folder_path: "INBOX.Snoozed" },
      { id: "folder-INBOX.Later", name: "Later", imap_folder_path: "INBOX.Later" },
    ]);

    const destination = await resolveSnoozeDestination("acc-1");

    expect(destination).toMatchObject({ folderPath: "INBOX.Later" });
  });

  it("matches the folder name regardless of case", async () => {
    mockGetAccount.mockResolvedValue(imapAccount());
    mockSelect.mockResolvedValue([
      { id: "folder-INBOX.SNOOZED", name: "SNOOZED", imap_folder_path: "INBOX.SNOOZED" },
    ]);

    expect(await resolveSnoozeDestination("acc-1")).toMatchObject({
      folderPath: "INBOX.SNOOZED",
    });
  });

  it("creates a Later folder when the account has none", async () => {
    mockGetAccount.mockResolvedValue(imapAccount());
    mockSelect.mockResolvedValue([
      { id: "folder-INBOX.Archive", name: "Archive", imap_folder_path: "INBOX.Archive" },
    ]);

    const destination = await resolveSnoozeDestination("acc-1");

    expect(destination).toMatchObject({ kind: "folder", folderPath: "INBOX.Later" });
    expect(mockCreateFolder).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com" }),
      "INBOX.Later",
    );
  });

  it("takes the hierarchy separator from an existing folder rather than assuming", async () => {
    // Servers differ: "." on Dovecot, "/" elsewhere. Guessing wrong creates a
    // mailbox with a literal dot or slash in its name.
    mockGetAccount.mockResolvedValue(imapAccount());
    mockSelect.mockResolvedValue([
      { id: "folder-INBOX/Archive", name: "Archive", imap_folder_path: "INBOX/Archive" },
    ]);

    await resolveSnoozeDestination("acc-1");

    expect(mockCreateFolder).toHaveBeenCalledWith(expect.anything(), "INBOX/Later");
  });

  it("creates a top-level folder when nothing is nested under INBOX", async () => {
    mockGetAccount.mockResolvedValue(imapAccount());
    mockSelect.mockResolvedValue([
      { id: "folder-Archive", name: "Archive", imap_folder_path: "Archive" },
    ]);

    await resolveSnoozeDestination("acc-1");

    expect(mockCreateFolder).toHaveBeenCalledWith(expect.anything(), "Later");
  });

  it("uses a label on Gmail, since its own snooze is not in the API", async () => {
    mockGetAccount.mockResolvedValue(gmailAccount());
    mockSelect.mockResolvedValue([{ id: "Label_42" }]);

    expect(await resolveSnoozeDestination("acc-1")).toEqual({
      kind: "label",
      labelId: "Label_42",
    });
  });

  it("returns nothing for a Gmail account with no snooze label", async () => {
    mockGetAccount.mockResolvedValue(gmailAccount());

    expect(await resolveSnoozeDestination("acc-1")).toBeNull();
  });

  it("returns nothing for an account that does not exist", async () => {
    mockGetAccount.mockResolvedValue(null);

    expect(await resolveSnoozeDestination("gone")).toBeNull();
  });
});
