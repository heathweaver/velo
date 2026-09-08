/**
 * ThreadCard (Web Component)
 * Fast, individual email thread row.
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { useThreadStore, type Thread } from "@/stores/threadStore.ts";
import { router } from "../../router/index.ts";

export class ThreadCardElement extends VeloElement {
  private thread: Thread | null = null;
  private isSelected = false;

  setThreadData(thread: Thread, isSelected: boolean): void {
    this.thread = thread;
    this.isSelected = isSelected;
    this.render();
  }

  protected render(): void {
    if (!this.thread) return;

    const {
      id,
      subject,
      snippet,
      fromName,
      fromAddress,
      isRead,
      isStarred,
      hasAttachments,
      lastMessageAt,
      messageCount,
    } = this.thread;

    const dateStr = this.formatDate(lastMessageAt);
    const sender = fromName || fromAddress || "Unknown Sender";

    this.className = `group flex items-center gap-3 px-3 py-2.5 border-b border-border-primary/40 cursor-pointer select-none transition-colors ${
      this.isSelected
        ? "bg-bg-selected border-l-2 border-l-accent"
        : isRead
          ? "hover:bg-bg-hover bg-transparent text-text-secondary"
          : "hover:bg-bg-hover bg-bg-secondary/20 font-semibold text-text-primary"
    }`;
    this.dataset.threadId = id;

    this.innerHTML = `
      <!-- Unread Indicator / Star -->
      <div class="flex items-center gap-1.5 flex-shrink-0">
        ${
          !isRead
            ? `<div class="w-2 h-2 rounded-full bg-accent"></div>`
            : `<div class="w-2 h-2"></div>`
        }
        <button class="star-btn p-0.5 text-text-tertiary hover:text-amber-400 transition-colors ${
          isStarred ? "text-amber-400 fill-amber-400" : ""
        }">
          ${renderIcon("star", "w-3.5 h-3.5")}
        </button>
      </div>

      <!-- Main info -->
      <div class="min-w-0 flex-1 flex flex-col gap-0.5">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0 truncate">
            <span class="text-xs truncate ${!isRead ? "font-bold text-text-primary" : "text-text-secondary"}">
              ${this.escapeHtml(sender)}
            </span>
            ${
              messageCount > 1
                ? `<span class="text-[10px] px-1 py-0.2 rounded bg-bg-tertiary text-text-tertiary">${messageCount}</span>`
                : ""
            }
          </div>
          <div class="flex items-center gap-1.5 flex-shrink-0 text-[11px] text-text-tertiary">
            ${hasAttachments ? renderIcon("paperclip", "w-3 h-3") : ""}
            <span>${dateStr}</span>
          </div>
        </div>

        <div class="text-xs truncate text-text-primary font-medium">
          ${this.escapeHtml(subject || "(No Subject)")}
        </div>

        <div class="text-[11px] truncate text-text-tertiary">
          ${this.escapeHtml(snippet || "")}
        </div>
      </div>
    `;

    this.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".star-btn")) {
        e.stopPropagation();
        useThreadStore.getState().updateThread(id, { isStarred: !isStarred });
        return;
      }
      useThreadStore.getState().selectThread(id);
      router.setThread(id);
    });
  }

  private formatDate(timestamp: number): string {
    if (!timestamp) return "";
    const date = new Date(timestamp > 1e12 ? timestamp : timestamp * 1000);
    const now = new Date();
    const isToday =
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
}

customElements.define("velo-thread-card", ThreadCardElement);
