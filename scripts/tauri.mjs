#!/usr/bin/env node
/**
 * Thin wrapper around the Tauri CLI that accepts `--port <n>` (or
 * `VELO_DEV_PORT`) for `tauri dev`, keeping Vite and Tauri's devUrl in sync.
 *
 * Usage:
 *   npm run tauri dev -- --port 1422
 *   VELO_DEV_PORT=1422 npm run tauri dev
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

function parseArgs(argv) {
  const forwarded = [];
  let port = undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        console.error("error: --port requires a value");
        process.exit(1);
      }
      port = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
      continue;
    }
    forwarded.push(arg);
  }

  return { forwarded, port };
}

function resolvePort(flagPort) {
  const raw = flagPort ?? process.env.VELO_DEV_PORT;
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`error: invalid port "${raw}" (expected 1–65535)`);
    process.exit(1);
  }
  return port;
}

const { forwarded, port: flagPort } = parseArgs(process.argv.slice(2));
const isDev = forwarded[0] === "dev";
const port = isDev ? resolvePort(flagPort) : undefined;

if (flagPort !== undefined && !isDev) {
  console.error("error: --port is only supported with `tauri dev`");
  process.exit(1);
}

const env = { ...process.env };
const tauriArgs = [...forwarded];

if (port !== undefined) {
  env.VELO_DEV_PORT = String(port);
  // Override tauri.conf.json so the WebView loads the same port Vite binds.
  tauriArgs.push(
    "--config",
    JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }),
  );
}

const require = createRequire(import.meta.url);
const tauriCli = require.resolve("@tauri-apps/cli/tauri.js");

const child = spawn(process.execPath, [tauriCli, ...tauriArgs], {
  stdio: "inherit",
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
