/**
 * Main Application Root (Web Component)
 * Orchestrates layout panes, routing views, and global components.
 */

import { VeloElement } from "./core/component.ts";
import { router, type RouteState } from "./router/index.ts";
import { useUIStore } from "@/stores/uiStore.ts";
import { useAccountStore } from "@/stores/accountStore.ts";
import { getAllAccounts } from "@/services/db/accounts.ts";

import "./components/layout/TitleBar.ts";
import "./components/layout/Sidebar.ts";
import "./components/layout/EmailList.ts";
import "./components/email/ThreadView.ts";
import "./components/composer/Composer.ts";
import "./components/search/CommandPalette.ts";

export class VeloAppElement extends VeloElement {
  private currentView: RouteState["view"] = "mail";

  protected async setup(): Promise<void> {
    // 1. Restore theme & settings
    this.bindStore(
      useUIStore,
      (s) => s.theme,
      (theme) => {
        const isDark =
          theme === "dark" ||
          (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.classList.toggle("dark", isDark);
      },
    );

    // 2. Load accounts from SQLite
    try {
      const accounts = await getAllAccounts();
      const mapped = accounts.map((a) => ({
        id: a.id,
        email: a.email,
        displayName: a.display_name,
        avatarUrl: a.avatar_url,
        isActive: Boolean(a.is_active),
        provider: a.provider,
      }));
      useAccountStore.getState().setAccounts(mapped);
    } catch (err) {
      console.warn("[VeloApp] Error loading accounts from DB:", err);
    }

    // 3. Subscribe to router view changes
    this.cleanups.push(
      router.subscribe((state) => {
        if (state.view !== this.currentView) {
          this.currentView = state.view;
          this.renderContent();
        }
      }),
    );
  }

  protected render(): void {
    this.className = "flex flex-col w-screen h-screen overflow-hidden bg-bg-primary text-text-primary font-sans antialiased";

    this.innerHTML = `
      <!-- Title Bar -->
      <velo-title-bar></velo-title-bar>

      <!-- Main App Body -->
      <div class="flex flex-1 overflow-hidden relative">
        <!-- Sidebar -->
        <velo-sidebar></velo-sidebar>

        <!-- Dynamic Content View Area -->
        <main id="main-content" class="flex flex-1 overflow-hidden">
          <!-- Views mounted dynamically -->
        </main>
      </div>

      <!-- Overlays / Modals -->
      <velo-composer></velo-composer>
      <velo-command-palette></velo-command-palette>
    `;

    this.renderContent();
  }

  private renderContent(): void {
    const main = this.querySelector<HTMLElement>("#main-content");
    if (!main) return;

    main.innerHTML = "";

    if (this.currentView === "mail") {
      main.innerHTML = `
        <velo-email-list></velo-email-list>
        <velo-thread-view></velo-thread-view>
      `;
    } else if (this.currentView === "calendar") {
      main.innerHTML = `
        <div class="flex flex-col flex-1 p-8 items-center justify-center text-text-tertiary">
          <h2 class="text-base font-semibold text-text-primary mb-1">Calendar</h2>
          <p class="text-xs">Google & CalDAV Calendar integration view</p>
        </div>
      `;
    } else if (this.currentView === "tasks") {
      main.innerHTML = `
        <div class="flex flex-col flex-1 p-8 items-center justify-center text-text-tertiary">
          <h2 class="text-base font-semibold text-text-primary mb-1">Tasks</h2>
          <p class="text-xs">Task management and AI extracted action items</p>
        </div>
      `;
    } else if (this.currentView === "settings") {
      main.innerHTML = `
        <div class="flex flex-col flex-1 p-8 text-text-primary">
          <h2 class="text-base font-bold mb-4">Settings</h2>
          <div class="max-w-md bg-bg-secondary/40 border border-border-primary rounded-xl p-4 flex flex-col gap-3 text-xs">
            <div><strong>Database:</strong> Native Deno SQLite (node:sqlite)</div>
            <div><strong>Runtime:</strong> Deno Desktop 2.9+</div>
            <div><strong>Frontend:</strong> Vanilla TypeScript & Web Components</div>
          </div>
        </div>
      `;
    }
  }
}

customElements.define("velo-app", VeloAppElement);
