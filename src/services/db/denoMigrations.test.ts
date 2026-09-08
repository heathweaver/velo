import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import { DatabaseSync } from "node:sqlite";
import { setDenoDb, denoTransport } from "../transport/denoTransport.ts";
import { runMigrations } from "./migrations.ts";

describe("Deno SQLite & Migrations", () => {
  it("executes all 19 migrations on in-memory SQLite", async () => {
    const memDb = new DatabaseSync(":memory:");
    setDenoDb(memDb);

    await runMigrations();

    // Verify _migrations table has versions
    const applied = await denoTransport.select<{ version: number; description: string }[]>(
      "SELECT version, description FROM _migrations ORDER BY version ASC",
    );

    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]?.version).toBe(1);

    // Verify key tables exist
    const tables = await denoTransport.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("accounts");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("threads");
    expect(tableNames).toContain("labels");
    expect(tableNames).toContain("contacts");
    expect(tableNames).toContain("settings");
    expect(tableNames).toContain("tasks");
  });
});
