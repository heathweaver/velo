import type { Reporter, TestModule } from "vitest/node";

/**
 * Prints the one-line summary the Meant Librarian counts tests from
 * (`ok | N passed | N failed | N skipped`). Vitest's own summary is a format
 * the Librarian does not read, so without this a green run counts as zero tests.
 */
export default class LibrarianSummaryReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const mod of testModules) {
      for (const test of mod.children.allTests()) {
        const state = test.result().state;
        if (state === "passed") passed++;
        else if (state === "failed") failed++;
        else skipped++;
      }
    }
    const status = failed === 0 ? "ok" : "FAILED";
    console.log(`\n${status} | ${passed} passed | ${failed} failed | ${skipped} skipped`);
  }
}
