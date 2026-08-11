import { writeTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";

/**
 * Mirror webview errors to a file next to the database.
 *
 * The Rust log captures nothing that happens in the webview, so a JavaScript
 * exception — a thrown render, a rejected promise, a console.error swallowed by
 * a catch — leaves no trace anywhere on disk. Several failures this codebase
 * exhibits (actions that silently do nothing, panes that render empty) are only
 * visible in devtools, which means they are invisible in a normal session and
 * in any bug report. Writing them to AppData makes them inspectable after the
 * fact.
 */
const LOG_FILE = "velo-webview.log";

let queue: string[] = [];
let flushing = false;

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    await writeTextFile(LOG_FILE, batch.join(""), {
      baseDir: BaseDirectory.AppData,
      append: true,
    });
  } catch {
    // Never let diagnostics break the app; drop the batch instead.
  } finally {
    flushing = false;
    if (queue.length > 0) void flush();
  }
}

function record(kind: string, parts: unknown[]): void {
  const text = parts
    .map((p) => {
      if (p instanceof Error) return `${p.name}: ${p.message}\n${p.stack ?? ""}`;
      if (typeof p === "string") return p;
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    })
    .join(" ");

  queue.push(`[${new Date().toISOString()}][${kind}] ${text}\n`);
  void flush();
}

export function installWebviewErrorLog(): void {
  window.addEventListener("error", (e) => {
    record("error", [e.message, e.error ?? `${e.filename}:${e.lineno}`]);
  });

  window.addEventListener("unhandledrejection", (e) => {
    record("unhandledrejection", [e.reason]);
  });

  // console.error/warn are where this app reports most of its failures, and
  // nothing else persists them.
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    record("console.error", args);
    originalError(...args);
  };

  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    record("console.warn", args);
    originalWarn(...args);
  };
}
