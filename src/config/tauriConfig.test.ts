import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("tauri.conf.json", () => {
  const configPath = resolve(__dirname, "../../src-tauri/tauri.conf.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));

  it("should disable native drag-drop on the main window so HTML5 events reach the webview", () => {
    const mainWindow = config.app.windows.find(
      (w: { label: string }) => w.label === "main",
    );
    expect(mainWindow).toBeDefined();
    expect(mainWindow.dragDropEnabled).toBe(false);
  });

  describe("content security policy", () => {
    const csp: string = config.app.security.csp;
    const directive = (name: string) =>
      csp
        .split(";")
        .map((d: string) => d.trim())
        .find((d: string) => d.startsWith(`${name} `)) ?? "";

    it("allows https images so the remote-image setting can actually load them", () => {
      // Remote images are blocked by rewriting <img src> to data-blocked-src in
      // imageBlocker, which keeps the URL out of the DOM entirely. The CSP was
      // therefore never what protected privacy — it only made "load remote
      // images" impossible to honour, refusing every sender's images at the
      // webview level regardless of the user's choice.
      expect(directive("img-src")).toContain("https:");
    });

    it("still refuses plaintext http images", () => {
      // Opting in to images should not also opt in to cleartext requests.
      expect(directive("img-src")).not.toMatch(/(^|\s)http:(\s|$)/);
    });

    it("keeps scripts restricted to the app itself", () => {
      // Email HTML is rendered in this webview, so script execution must stay
      // locked down no matter what img-src allows.
      expect(directive("script-src")).toBe("script-src 'self'");
    });
  });
});
