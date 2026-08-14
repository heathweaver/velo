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

/**
 * Answer the two queries separately: which threads are unlabelled, and where
 * those threads' messages live. Handing the same rows to both would let a test
 * pass without the second query ever being reached.
 */
function given({
  unlabelledThreads = [] as string[],
  messageFolders = [] as { thread_id: string; imap_folder: string }[],
} = {}) {
  mockSelect.mockImplementation((sql: string) => {
    if (sql.includes("FROM threads")) {
      return Promise.resolve(unlabelledThreads.map((id) => ({ id })));
    }
    return Promise.resolve(messageFolders);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue(undefined);
  given();
});

describe("repairMissingThreadLabels", () => {
  it("labels a thread whose messages are in the inbox", async () => {
    // The failure this exists for: messages stored, thread unlabelled, so the
    // mail is in no folder and no view — present but invisible.
    given({
      unlabelledThreads: ["t1"],
      messageFolders: [{ thread_id: "t1", imap_folder: "INBOX" }],
    });

    const repaired = await repairMissingThreadLabels("acc-1", FOLDERS);

    expect(repaired).toBe(1);
    const [, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["acc-1", "t1", "INBOX"]);
  });

  it("gives a thread a label for every folder it appears in", async () => {
    // A thread can hold an inbox copy and an archived one; dropping either
    // would make it vanish from that folder's view.
    given({
      unlabelledThreads: ["t1"],
      messageFolders: [
        { thread_id: "t1", imap_folder: "INBOX" },
        { thread_id: "t1", imap_folder: "INBOX.Archive" },
      ],
    });

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

  it("does not read the messages table when nothing is unlabelled", async () => {
    // This runs at the start of every sync and nearly always finds nothing.
    // Asking messages anyway meant reading one fat row per message, bodies and
    // all, to answer a question about labels — minutes of disk on a large
    // mailbox, starving every other query in the app.
    given({ unlabelledThreads: [] });

    const repaired = await repairMissingThreadLabels("acc-1", FOLDERS);

    expect(repaired).toBe(0);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect.mock.calls[0]![0]).toContain("FROM threads");
  });

  it("asks the messages table only about the threads that need repair", async () => {
    given({
      unlabelledThreads: ["t1", "t2"],
      messageFolders: [{ thread_id: "t1", imap_folder: "INBOX" }],
    });

    await repairMissingThreadLabels("acc-1", FOLDERS);

    const [sql, params] = mockSelect.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain("thread_id IN ($2, $3)");
    expect(params).toEqual(["acc-1", "t1", "t2"]);
  });

  it("skips messages from a folder the server no longer reports", async () => {
    // A folder deleted server-side has no label to map to; inventing one would
    // put the thread in a folder that does not exist.
    given({
      unlabelledThreads: ["t1"],
      messageFolders: [{ thread_id: "t1", imap_folder: "INBOX.Deleted Folder" }],
    });

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
