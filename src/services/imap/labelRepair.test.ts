import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockExecute = vi.fn();

vi.mock("@/services/db/connection", () => ({
  getDb: () => Promise.resolve({ select: mockSelect, execute: mockExecute }),
}));

import { repairMissingThreadLabels } from "./labelRepair";
import type { ImapFolder } from "./tauriCommands";

function folder(rawPath: string, overrides: Partial<ImapFolder> = {}): ImapFolder {
  const name = rawPath.split(".").pop() ?? rawPath;
  return {
    name,
    path: rawPath,
    raw_path: rawPath,
    delimiter: ".",
    special_use: null,
    exists: 0,
    ...overrides,
  } as ImapFolder;
}

const FOLDERS = [folder("INBOX"), folder("INBOX.Archive"), folder("INBOX.Reads")];

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue(undefined);
  mockSelect.mockResolvedValue([]);
});

describe("repairMissingThreadLabels", () => {
  it("labels a thread whose messages are in the inbox", async () => {
    // The failure this exists for: messages stored, thread unlabelled, so the
    // mail is in no folder and no view — present but invisible.
    mockSelect.mockResolvedValue([{ thread_id: "t1", imap_folder: "INBOX" }]);

    const repaired = await repairMissingThreadLabels("acc-1", FOLDERS);

    expect(repaired).toBe(1);
    const [, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["acc-1", "t1", "INBOX"]);
  });

  it("gives a thread a label for every folder it appears in", async () => {
    // A thread can hold an inbox copy and an archived one; dropping either
    // would make it vanish from that folder's view.
    mockSelect.mockResolvedValue([
      { thread_id: "t1", imap_folder: "INBOX" },
      { thread_id: "t1", imap_folder: "INBOX.Archive" },
    ]);

    const repaired = await repairMissingThreadLabels("acc-1", FOLDERS);

    expect(repaired).toBe(1);
    // Both labels go in one batched statement rather than a round trip each.
    const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("($1, $2, $3), ($4, $5, $6)");
    expect(params).toEqual(["acc-1", "t1", "INBOX", "acc-1", "t1", "archive"]);
  });

  it("only asks about threads that have no labels at all", async () => {
    // A thread with some labels was written by the normal path; rewriting it
    // here would fight the folder-move logic rather than repair anything.
    await repairMissingThreadLabels("acc-1", FOLDERS);

    const [sql] = mockSelect.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("thread_labels");
  });

  it("skips messages from a folder the server no longer reports", async () => {
    // A folder deleted server-side has no label to map to; inventing one would
    // put the thread in a folder that does not exist.
    mockSelect.mockResolvedValue([
      { thread_id: "t1", imap_folder: "INBOX.Deleted Folder" },
    ]);

    const repaired = await repairMissingThreadLabels("acc-1", FOLDERS);

    expect(repaired).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("writes nothing when every thread already has labels", async () => {
    const repaired = await repairMissingThreadLabels("acc-1", FOLDERS);

    expect(repaired).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("does nothing when the account has no folders", async () => {
    // Without a folder list there is no mapping, and guessing would be worse
    // than leaving the repair for the next sync.
    const repaired = await repairMissingThreadLabels("acc-1", []);

    expect(repaired).toBe(0);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
