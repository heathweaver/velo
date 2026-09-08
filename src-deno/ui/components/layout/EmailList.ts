/**
 * EmailList (Web Component)
 * Handles fast rendering of thread lists, search filtering, category tabs, and Superhuman keyboard shortcuts.
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { useThreadStore, type Thread } from "@/stores/threadStore.ts";
import { useAccountStore } from "@/stores/accountStore.ts";
import { router, type RouteState } from "../../router/index.ts";
import { getThreadsForAccount } from "@/services/db/threads.ts";
import { archiveThread, trashThread, starThread } from "@/services/emailActions.ts";
import { ThreadCardElement } from "../email/ThreadCard.ts";
import "../email/CategoryTabs.ts";

export class EmailListElement extends VeloElement {
  private activeLabel = "inbox";
  private activeCategory = "All";
  private searchFilter = "";

  protected setup(): void {
    this.cleanups.push(
      router.subscribe((state: RouteState) => {
        const labelChanged = state.label !== this.activeLabel;
        const categoryChanged = state.category !== this.activeCategory;
        this.activeLabel = state.label;
        this.activeCategory = state.category;

        if (labelChanged || categoryChanged) {
          this.loadThreads();
        }
      }),
    );

    this.bindStore(
      useAccountStore,
      (s) => s.activeAccountId,
      () => this.loadThreads(),
    );

    this.bindStore(
      useThreadStore,
      (s) => s.threads,
      () => this.renderThreads(),
    );

    this.bindStore(
      useThreadStore,
      (s) => s.selectedThreadId,
      () => this.updateSelectionHighlight(),
    );

    // Global keyboard navigation (j/k, e, s, #)
    this.listen(window, "keydown", (e: Event) => this.handleKeyDown(e as KeyboardEvent));
  }

  protected render(): void {
    this.className = "flex flex-col h-full bg-bg-primary border-r border-border-primary w-80 md:w-96 flex-shrink-0 overflow-hidden";

    this.innerHTML = `
      <!-- Header: Title & Search -->
      <div class="p-3 border-b border-border-primary/50 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-bold capitalize text-text-primary">
            ${this.activeLabel}
          </h2>
        </div>

        <div class="relative flex items-center">
          <span class="absolute left-2.5 text-text-tertiary">
            ${renderIcon("search", "w-3.5 h-3.5")}
          </span>
          <input
            id="search-input"
            type="text"
            placeholder="Search mail..."
            class="w-full pl-8 pr-3 py-1.5 bg-bg-secondary border border-border-secondary/60 rounded-lg text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
          />
        </div>
      </div>

      <!-- Category Tabs (Shown in Inbox view) -->
      ${this.activeLabel === "inbox" ? "<velo-category-tabs></velo-category-tabs>" : ""}

      <!-- Threads Container -->
      <div id="threads-container" class="flex-1 overflow-y-auto divide-y divide-border-primary/20">
        <!-- Rendered dynamically -->
      </div>
    `;

    const searchInput = this.querySelector<HTMLInputElement>("#search-input");
    searchInput?.addEventListener("input", () => {
      this.searchFilter = searchInput.value.toLowerCase();
      this.renderThreads();
    });

    this.renderThreads();
  }

  private async loadThreads(): Promise<void> {
    const activeAccountId = useAccountStore.getState().activeAccountId;
    if (!activeAccountId) return;

    try {
      useThreadStore.getState().setLoading(true);
      const dbThreads = await getThreadsForAccount(activeAccountId, this.activeLabel);
      const mapped: Thread[] = dbThreads.map((t) => ({
        id: t.id,
        accountId: t.account_id,
        subject: t.subject,
        snippet: t.snippet,
        lastMessageAt: t.last_message_at,
        messageCount: t.message_count,
        isRead: Boolean(t.is_read),
        isStarred: Boolean(t.is_starred),
        isPinned: Boolean(t.is_pinned),
        isMuted: Boolean(t.is_muted),
        hasAttachments: Boolean(t.has_attachments),
        labelIds: [],
        fromName: null,
        fromAddress: null,
      }));
      useThreadStore.getState().setThreads(mapped);
    } catch (err) {
      console.error("[EmailList] Failed to load threads:", err);
    } finally {
      useThreadStore.getState().setLoading(false);
    }
  }

  private renderThreads(): void {
    const container = this.querySelector<HTMLElement>("#threads-container");
    if (!container) return;

    const allThreads = useThreadStore.getState().threads;
    const selectedThreadId = useThreadStore.getState().selectedThreadId;

    let filtered = allThreads;
    if (this.searchFilter) {
      filtered = filtered.filter(
        (t) =>
          t.subject?.toLowerCase().includes(this.searchFilter) ||
          t.snippet?.toLowerCase().includes(this.searchFilter),
      );
    }

    container.innerHTML = "";

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="flex flex-col items-center justify-center p-8 text-center text-text-tertiary">
          <div class="mb-2">${renderIcon("inbox", "w-8 h-8 opacity-40")}</div>
          <p class="text-xs">No emails in ${this.activeLabel}</p>
        </div>
      `;
      return;
    }

    for (const thread of filtered) {
      const card = document.createElement("velo-thread-card") as ThreadCardElement;
      card.setThreadData(thread, thread.id === selectedThreadId);
      container.appendChild(card);
    }
  }

  private updateSelectionHighlight(): void {
    const selectedId = useThreadStore.getState().selectedThreadId;
    const cards = this.querySelectorAll<ThreadCardElement>("velo-thread-card");
    cards.forEach((card) => {
      const id = card.dataset.threadId;
      card.classList.toggle("bg-bg-selected", id === selectedId);
      card.classList.toggle("border-l-2", id === selectedId);
      card.classList.toggle("border-l-accent", id === selectedId);
    });
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Ignore keybindings if typing in an input or editable field
    const activeEl = document.activeElement;
    if (
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement ||
      activeEl?.getAttribute("contenteditable") === "true"
    ) {
      return;
    }

    const threads = useThreadStore.getState().threads;
    const selectedId = useThreadStore.getState().selectedThreadId;
    const activeAccountId = useAccountStore.getState().activeAccountId;
    if (!threads.length || !activeAccountId) return;

    const currentIndex = threads.findIndex((t) => t.id === selectedId);

    if (e.key === "j") {
      // Move Down
      e.preventDefault();
      const nextIndex = currentIndex < threads.length - 1 ? currentIndex + 1 : 0;
      const nextThread = threads[nextIndex];
      if (nextThread) {
        useThreadStore.getState().selectThread(nextThread.id);
        router.setThread(nextThread.id);
      }
    } else if (e.key === "k") {
      // Move Up
      e.preventDefault();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : threads.length - 1;
      const prevThread = threads[prevIndex];
      if (prevThread) {
        useThreadStore.getState().selectThread(prevThread.id);
        router.setThread(prevThread.id);
      }
    } else if (e.key === "e" && selectedId) {
      // Archive
      e.preventDefault();
      archiveThread(activeAccountId, selectedId, []);
    } else if (e.key === "s" && selectedId) {
      // Star / Unstar
      e.preventDefault();
      const current = threads.find((t) => t.id === selectedId);
      if (current) {
        starThread(activeAccountId, selectedId, [], !current.isStarred);
      }
    } else if ((e.key === "#" || e.key === "Delete" || e.key === "Backspace") && selectedId) {
      // Trash
      e.preventDefault();
      trashThread(activeAccountId, selectedId, []);
    }
  }
}

customElements.define("velo-email-list", EmailListElement);
