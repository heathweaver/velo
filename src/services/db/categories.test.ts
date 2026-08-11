import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();
const mockSelect = vi.fn();

vi.mock("./connection", () => ({
  getDb: () => Promise.resolve({ execute: mockExecute, select: mockSelect }),
}));

import { createCategory, deleteCategory, updateCategory } from "./categories";

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    description: "",
    icon: null,
    sort_order: 0,
    is_enabled: 1,
    is_default: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue(undefined);
  mockSelect.mockResolvedValue([]);
});

describe("createCategory", () => {
  it("derives a url-safe id from the name", async () => {
    const id = await createCategory({ name: "Paper Trail", description: "Receipts" });
    expect(id).toBe("paper-trail");
  });

  it("does not collide with an existing id", async () => {
    // Two categories sharing an id would silently merge their mail, since
    // thread_categories rows only store the id.
    mockSelect.mockResolvedValue([row("reads")]);

    const id = await createCategory({ name: "Reads", description: "" });

    expect(id).toBe("reads-2");
  });

  it("falls back to a usable id when the name has no alphanumerics", async () => {
    const id = await createCategory({ name: "★★★", description: "" });
    expect(id).toBe("category");
  });

  it("appends after the existing categories", async () => {
    mockSelect.mockResolvedValue([row("a", { sort_order: 0 }), row("b", { sort_order: 7 })]);

    await createCategory({ name: "Reads", description: "" });

    const params = mockExecute.mock.calls[0]![1] as unknown[];
    expect(params[4]).toBe(8);
  });
});

describe("updateCategory", () => {
  it("does not touch the database when given nothing to change", async () => {
    await updateCategory("reads", {});
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("updates only the fields provided", async () => {
    await updateCategory("reads", { isEnabled: false });

    const [sql, params] = mockExecute.mock.calls[0]!;
    expect(sql).toContain("is_enabled");
    expect(sql).not.toContain("description");
    expect(params).toEqual([0, "reads"]);
  });
});

describe("deleteCategory", () => {
  it("moves mail to the default category rather than orphaning it", async () => {
    // Rows left pointing at a deleted category would drop those threads out of
    // every category view without deleting the mail, which reads as data loss.
    mockSelect.mockResolvedValue([
      row("Primary", { is_default: 1 }),
      row("reads"),
    ]);

    await deleteCategory("reads");

    const reassign = mockExecute.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE thread_categories"),
    );
    expect(reassign?.[1]).toEqual(["Primary", "reads"]);
  });

  it("refuses to delete the default category", async () => {
    // It is the fallback every other deletion depends on.
    mockSelect.mockResolvedValue([row("Primary", { is_default: 1 })]);

    await deleteCategory("Primary");

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("is a no-op for a category that does not exist", async () => {
    mockSelect.mockResolvedValue([row("Primary", { is_default: 1 })]);

    await deleteCategory("nope");

    expect(mockExecute).not.toHaveBeenCalled();
  });
});
