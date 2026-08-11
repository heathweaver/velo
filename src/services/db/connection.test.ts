import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the transport layer before importing module under test. connection.ts
// now backs select/execute with the active transport instead of the Tauri SQL
// plugin directly.
const mockExecute = vi.fn();
const mockSelect = vi.fn();

vi.mock("../transport", () => ({
  getTransport: () => ({ execute: mockExecute, select: mockSelect }),
  isWeb: () => false,
}));

// Use dynamic import so mocks are in place
const { withTransaction, getDb } = await import("./connection");

describe("withTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("runs the callback without emitting raw transaction statements", async () => {
    const callOrder: string[] = [];
    mockExecute.mockImplementation(async (sql: string) => {
      callOrder.push(sql);
    });

    await withTransaction(async (db) => {
      callOrder.push("callback");
      await db.execute("INSERT INTO threads (id) VALUES ($1)", ["t1"]);
    });

    // BEGIN/COMMIT/ROLLBACK are deliberately absent: neither transport pins
    // consecutive statements to one SQLite connection, so an explicit
    // transaction could strand the write lock on a pooled connection.
    expect(callOrder).toEqual(["callback", "INSERT INTO threads (id) VALUES ($1)"]);
    expect(callOrder).not.toContain("BEGIN TRANSACTION");
    expect(callOrder).not.toContain("COMMIT");
  });

  it("propagates callback errors without issuing a ROLLBACK", async () => {
    const callOrder: string[] = [];
    mockExecute.mockImplementation(async (sql: string) => {
      callOrder.push(sql);
    });

    await expect(
      withTransaction(async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    expect(callOrder).not.toContain("ROLLBACK");
  });

  it("serialises concurrent transactions via mutex", async () => {
    const executionLog: string[] = [];

    mockExecute.mockImplementation(async (sql: string) => {
      executionLog.push(sql);
    });

    // Launch two transactions concurrently
    const tx1 = withTransaction(async () => {
      executionLog.push("tx1-work");
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      executionLog.push("tx1-done");
    });

    const tx2 = withTransaction(async () => {
      executionLog.push("tx2-work");
    });

    await Promise.all([tx1, tx2]);

    // tx1 must fully complete before tx2 starts — the mutex is now the only
    // thing serialising writes, so this is the load-bearing guarantee.
    expect(executionLog).toEqual(["tx1-work", "tx1-done", "tx2-work"]);
  });

  it("unblocks next transaction even if current one fails", async () => {
    mockExecute.mockResolvedValue(undefined);

    // First transaction fails
    const tx1 = withTransaction(async () => {
      throw new Error("tx1 failed");
    }).catch(() => {
      /* expected */
    });

    // Second transaction should still run
    let tx2Ran = false;
    const tx2 = withTransaction(async () => {
      tx2Ran = true;
    });

    await Promise.all([tx1, tx2]);

    expect(tx2Ran).toBe(true);
  });
});

describe("getDb", () => {
  it("returns the same instance on repeated calls", async () => {
    const db1 = await getDb();
    const db2 = await getDb();
    expect(db1).toBe(db2);
  });
});
