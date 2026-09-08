/**
 * Main Application Sidebar (Web Component)
 * Manages mailbox navigation, accounts, label filters, and auxiliary views.
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { router, type RouteState } from "../../router/index.ts";
import { useAccountStore } from "@/stores/accountStore.ts";
import { useComposerStore } from "@/stores/composerStore.ts";
import { useUIStore } from "@/stores/uiStore.ts";

interface NavItem {
  id: string;
  label: string;
  icon: string;
  path: string;
}

const PRIMARY_NAV: NavItem[] = [
  { id: "inbox", label: "Inbox", icon: "inbox", path: "#/inbox" },
  { id: "starred", label: "Starred", icon: "star", path: "#/starred" },
  { id: "sent", label: "Sent", icon: "send", path: "#/sent" },
  { id: "drafts", label: "Drafts", icon: "file", path: "#/drafts" },
  { id: "snoozed", label: "Snoozed", icon: "snooze", path: "#/snoozed" },
  { id: "archive", label: "Archive", icon: "archive", path: "#/archive" },
  { id: "trash", label: "Trash", icon: "trash", path: "#/trash" },
  { id: "spam", label: "Spam", icon: "spam", path: "#/spam" },
];

const SECONDARY_NAV: NavItem[] = [
  { id: "calendar", label: "Calendar", icon: "calendar", path: "#/calendar" },
  { id: "tasks", label: "Tasks", icon: "tasks", path: "#/tasks" },
  { id: "settings", label: "Settings", icon: "settings", path: "#/settings" },
];

export class SidebarElement extends VeloElement {
  private activeLabel = "inbox";
  private currentView = "mail";

  protected setup(): void {
    this.cleanups.push(
      router.subscribe((state: RouteState) => {
        this.activeLabel = state.label;
        this.currentView = state.view;
        this.updateActiveItem();
      }),
    );

    this.bindStore(
      useAccountStore,
      (s) => s.activeAccountId,
      () => this.render(),
    );

    this.bindStore(
      useUIStore,
      (s) => s.sidebarCollapsed,
      () => this.render(),
    );
  }

  protected render(): void {
    const isCollapsed = useUIStore.getState().sidebarCollapsed;
    const accounts = useAccountStore.getState().accounts;
    const activeAccountId = useAccountStore.getState().activeAccountId;
    const activeAccount = accounts.find((a) => a.id === activeAccountId);

    this.className = `flex flex-col h-full bg-sidebar-bg border-r border-border-primary transition-all duration-200 ${
      isCollapsed ? "w-16" : "w-56"
    }`;

    this.innerHTML = `
      <!-- Account & Compose -->
      <div class="p-3 border-b border-border-primary/50 flex flex-col gap-2">
        <div class="flex items-center gap-2 px-1">
          <div class="w-7 h-7 rounded-full bg-accent/20 text-accent font-semibold flex items-center justify-center text-xs flex-shrink-0">
            ${activeAccount?.email?.slice(0, 2).toUpperCase() || "ME"}
          </div>
          ${
            !isCollapsed
              ? `<div class="min-w-0 flex-1 truncate text-xs font-medium text-text-primary">
                  ${this.escapeHtml(activeAccount?.email || "No Account")}
                </div>`
              : ""
          }
        </div>

        <button id="compose-btn" class="flex items-center justify-center gap-2 w-full py-2 px-3 bg-accent hover:bg-accent-hover text-white rounded-lg text-xs font-semibold shadow-sm transition-all cursor-pointer">
          ${renderIcon("plus", "w-4 h-4")}
          ${!isCollapsed ? "<span>Compose</span>" : ""}
        </button>
      </div>

      <!-- Navigation List -->
      <div class="flex-1 overflow-y-auto py-2 px-2 flex flex-col gap-1">
        ${PRIMARY_NAV.map((item) => this.renderNavItem(item, isCollapsed)).join("")}

        <div class="my-2 border-t border-border-primary/50"></div>

        ${SECONDARY_NAV.map((item) => this.renderNavItem(item, isCollapsed)).join("")}
      </div>

      <!-- Bottom collapse toggle -->
      <div class="p-2 border-t border-border-primary/50 flex justify-end">
        <button id="toggle-sidebar" class="p-1.5 hover:bg-bg-hover rounded text-text-tertiary hover:text-text-primary transition-colors cursor-pointer" title="Toggle Sidebar">
          ${renderIcon("menu", "w-4 h-4")}
        </button>
      </div>
    `;

    this.querySelector("#compose-btn")?.addEventListener("click", () => {
      useComposerStore.getState().openComposer({ mode: "new" });
    });

    this.querySelector("#toggle-sidebar")?.addEventListener("click", () => {
      useUIStore.getState().toggleSidebar();
    });

    this.updateActiveItem();
  }

  private renderNavItem(item: NavItem, isCollapsed: boolean): string {
    const isActive =
      this.currentView === item.id || (this.currentView === "mail" && this.activeLabel === item.id);

    return `
      <a href="${item.path}" data-id="${item.id}" class="nav-item flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
        isActive
          ? "bg-accent/10 text-accent font-semibold"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
      }" title="${item.label}">
        <span class="flex-shrink-0">${renderIcon(item.icon, "w-4 h-4")}</span>
        ${!isCollapsed ? `<span class="truncate">${item.label}</span>` : ""}
      </a>
    `;
  }

  private updateActiveItem(): void {
    const items = this.querySelectorAll<HTMLAnchorElement>(".nav-item");
    items.forEach((el) => {
      const id = el.dataset.id;
      const isActive =
        this.currentView === id || (this.currentView === "mail" && this.activeLabel === id);
      el.classList.toggle("bg-accent/10", isActive);
      el.classList.toggle("text-accent", isActive);
      el.classList.toggle("font-semibold", isActive);
      el.classList.toggle("text-text-secondary", !isActive);
    });
  }
}

customElements.define("velo-sidebar", SidebarElement);
