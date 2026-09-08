/**
 * ThreadView (Web Component)
 * Conversation Reading Pane displaying thread messages and action bar.
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { useThreadStore } from "@/stores/threadStore.ts";
import { useAccountStore } from "@/stores/accountStore.ts";
import { getMessagesForThread, type DbMessage } from "@/services/db/messages.ts";
import { ActionBarElement } from "./ActionBar.ts";
import { EmailRendererElement } from "./EmailRenderer.ts";
import "./ActionBar.ts";
import "./EmailRenderer.ts";

export class ThreadViewElement extends VeloElement {
  private threadId: string | null = null;
  private messages: DbMessage[] = [];
  private isLoading = false;

  protected setup(): void {
    this.bindStore(
      useThreadStore,
      (s) => s.selectedThreadId,
      (id) => {
        if (id !== this.threadId) {
          this.threadId = id;
          this.loadMessages();
        }
      },
    );
  }

  private async loadMessages(): Promise<void> {
    const activeAccountId = useAccountStore.getState().activeAccountId;
    if (!this.threadId || !activeAccountId) {
      this.messages = [];
      this.render();
      return;
    }

    this.isLoading = true;
    this.render();

    try {
      this.messages = await getMessagesForThread(activeAccountId, this.threadId);
    } catch (err) {
      console.error("[ThreadView] Failed to load messages:", err);
      this.messages = [];
    } finally {
      this.isLoading = false;
      this.render();
    }
  }

  protected render(): void {
    this.className = "flex flex-col flex-1 h-full bg-bg-primary overflow-hidden";

    if (!this.threadId) {
      this.innerHTML = `
        <div class="flex flex-col items-center justify-center flex-1 text-center p-8 text-text-tertiary">
          <div class="mb-3">${renderIcon("inbox", "w-12 h-12 opacity-30")}</div>
          <p class="text-sm font-medium">Select an email to read</p>
        </div>
      `;
      return;
    }

    const threads = useThreadStore.getState().threads;
    const thread = threads.find((t) => t.id === this.threadId);
    const subject = thread?.subject || "(No Subject)";

    this.innerHTML = `
      <!-- Action Bar -->
      <velo-action-bar id="action-bar"></velo-action-bar>

      <!-- Scrollable Message Stream -->
      <div class="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
        <!-- Subject Header -->
        <div class="border-b border-border-primary/50 pb-4">
          <h1 class="text-lg font-bold text-text-primary">
            ${this.escapeHtml(subject)}
          </h1>
        </div>

        <!-- Messages List -->
        <div id="messages-stream" class="flex flex-col gap-6">
          ${
            this.isLoading
              ? `<div class="py-8 text-center text-xs text-text-tertiary">Loading conversation...</div>`
              : this.messages.map((m, idx) => this.renderMessage(m, idx)).join("")
          }
        </div>
      </div>
    `;

    const actionBar = this.querySelector<ActionBarElement>("velo-action-bar");
    actionBar?.setThreadId(this.threadId);

    // Attach HTML to each message renderer
    this.querySelectorAll<EmailRendererElement>("velo-email-renderer").forEach((el) => {
      const msgId = el.dataset.msgId;
      const msg = this.messages.find((m) => m.id === msgId);
      if (msg) {
        el.setHtml(msg.body_html || msg.body_plain || "");
      }
    });
  }

  private renderMessage(msg: DbMessage, index: number): string {
    const sender = msg.from_name || msg.from_address || "Unknown";
    const dateStr = msg.internal_date
      ? new Date(msg.internal_date > 1e12 ? msg.internal_date : msg.internal_date * 1000).toLocaleString()
      : "";

    return `
      <div class="bg-bg-secondary/40 border border-border-primary/60 rounded-xl p-4 flex flex-col gap-3 shadow-xs">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <div class="w-8 h-8 rounded-full bg-accent/15 text-accent font-bold text-xs flex items-center justify-center flex-shrink-0">
              ${this.escapeHtml(sender.slice(0, 2).toUpperCase())}
            </div>
            <div class="flex flex-col">
              <div class="text-xs font-semibold text-text-primary">${this.escapeHtml(sender)}</div>
              <div class="text-[11px] text-text-tertiary">To: ${this.escapeHtml(msg.to_addresses || "Me")}</div>
            </div>
          </div>
          <div class="text-[11px] text-text-tertiary">${dateStr}</div>
        </div>

        <velo-email-renderer data-msg-id="${msg.id}"></velo-email-renderer>
      </div>
    `;
  }
}

customElements.define("velo-thread-view", ThreadViewElement);
