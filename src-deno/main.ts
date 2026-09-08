/**
 * Velo Desktop - Deno Desktop Entrypoint
 *
 * Hosts:
 * 1. Direct in-process SQLite database & runs schema migrations.
 * 2. Local HTTP server serving the Vanilla TS frontend.
 * 3. OAuth localhost server for Gmail PKCE authentication (port 17248).
 * 4. Desktop window & system tray integration.
 */

import { runMigrations } from "@/services/db/migrations.ts";
import { getDenoDb, registerDenoCommandHandler } from "@/services/transport/denoTransport.ts";

// 1. Initialize SQLite database and run schema migrations
console.log("[Velo Desktop] Initializing SQLite database...");
getDenoDb();
await runMigrations();
console.log("[Velo Desktop] Database ready.");

// 2. Register desktop-specific command handlers
registerDenoCommandHandler("close_splashscreen", () => {
  console.log("[Velo Desktop] Splash screen dismissed.");
});

registerDenoCommandHandler("set_tray_tooltip", (args) => {
  const tooltip = (args?.tooltip as string) || "Velo";
  console.log(`[Velo Desktop] Tray tooltip: ${tooltip}`);
});

// 3. Start OAuth Localhost Server for Gmail PKCE flow on port 17248
let oauthServer: Deno.HttpServer | null = null;
let pendingOAuthResolve: ((code: string) => void) | null = null;

registerDenoCommandHandler("start_oauth_server", () => {
  return new Promise((resolve) => {
    pendingOAuthResolve = resolve as (code: string) => void;
    if (!oauthServer) {
      try {
        oauthServer = Deno.serve(
          { port: 17248, onListen: () => console.log("[OAuth] Listening on http://localhost:17248") },
          (req) => {
            const url = new URL(req.url);
            const code = url.searchParams.get("code");
            if (code && pendingOAuthResolve) {
              pendingOAuthResolve(code);
              pendingOAuthResolve = null;
              return new Response(
                "<html><body style='font-family:sans-serif;text-align:center;padding-top:50px;background:#111;color:#eee'><h2>Authentication Successful!</h2><p>You can close this tab and return to Velo.</p></body></html>",
                { headers: { "Content-Type": "text/html" } },
              );
            }
            return new Response("Waiting for OAuth authorization...", { status: 200 });
          },
        );
      } catch (err) {
        console.warn("[OAuth] Port 17248 already in use or unavailable:", err);
      }
    }
  });
});

// 4. File server for Vanilla TS UI
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

function getContentType(path: string): string {
  for (const [ext, type] of Object.entries(MIME_TYPES)) {
    if (path.endsWith(ext)) return type;
  }
  return "text/plain";
}

const ROOT_DIR = new URL("..", import.meta.url).pathname;

const server = Deno.serve(
  { port: 1420, onListen: ({ port }) => console.log(`[Velo Desktop] UI server listening on http://localhost:${port}`) },
  async (req) => {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "/index.html") {
      pathname = "/src-deno/ui/index.html";
    }

    // Resolve file path
    let filePath = `${ROOT_DIR}${pathname}`;
    try {
      // If typescript file requested without extension
      if (!filePath.includes(".") && !filePath.endsWith("/")) {
        try {
          await Deno.stat(`${filePath}.ts`);
          filePath = `${filePath}.ts`;
        } catch {
          // Keep original
        }
      }

      const fileData = await Deno.readFile(filePath);
      return new Response(fileData, {
        headers: {
          "Content-Type": getContentType(filePath),
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch {
      return new Response(`File not found: ${pathname}`, { status: 404 });
    }
  },
);

console.log("[Velo Desktop] Application successfully running.");
