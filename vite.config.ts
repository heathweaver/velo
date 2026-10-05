import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
// `VITE_TARGET=web` builds the browser version (served by velo-server):
// no splashscreen entry, and the transport layer talks HTTP instead of Tauri IPC.
const isWeb = process.env.VITE_TARGET === "web";
// Override via `npm run tauri dev -- --port 1422` or `VELO_DEV_PORT=1422`.
const port = Number(process.env.VELO_DEV_PORT) || 1420;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Make the build target available to the transport selector.
    "import.meta.env.VITE_TARGET": JSON.stringify(
      process.env.VITE_TARGET ?? "tauri",
    ),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // The desktop build is multi-page (app + splashscreen window); the web
    // build is a single-page app, so it drops the splashscreen entry.
    rollupOptions: {
      input: isWeb
        ? { main: path.resolve(__dirname, "index.html") }
        : {
            main: path.resolve(__dirname, "index.html"),
            splashscreen: path.resolve(__dirname, "splashscreen.html"),
          },
    },
  },
  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
