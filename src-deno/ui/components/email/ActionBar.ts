/**
 * Thread ActionBar (Web Component)
 * Provides Superhuman-style action buttons (Archive, Trash, Spam, Snooze, Reply, Star).
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { useThreadStore } from "@/stores/threadStore.ts";
import { useAccountStore } from "@/stores/accountStore.ts";
import { useComposerStore } from "@/stores/composerStore.ts";
import { archiveThread, trashThread, starThread, spamThread } from "@/services/emailActions.ts";

export class ActionBarElement extends VeloElement {
  private threadId: string | null = null;

  setThreadId(threadId: string | null): void {
    this.threadId = threadId;
    this.render();
  }

  protected render(): void {
    if (!this.threadId) {
      this.innerHTML = "";
      return;
    }

    this.className = "flex items-center justify-between px-4 py-2 border-b border-border-primary/50 bg-bg-secondary/30";

    this.innerHTML = `
      <div class="flex items-center gap-1">
        <button id="archive-btn" class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer" title="Archive (e)">
          ${renderIcon("archive", "w-3.5 h-3.5")}
          <span>Archive</span>
        </button>

        <button id="trash-btn" class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-text-secondary hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer" title="Delete (#)">
          ${renderIcon("trash", "w-3.5 h-3.5")}
          <span>Delete</span>
        </button>

        <button id="spam-btn" class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer" title="Mark as Spam (!)">
          ${renderIcon("spam", "w-3.5 h-3.5")}
          <span>Spam</span>
        </button>

        <div class="h-4 w-px bg-border-primary/60 mx-1"></div>

        <button id="reply-btn" class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer" title="Reply (r)">
          ${renderIcon("reply", "w-3.5 h-3.5")}
          <span>Reply</span>
        </button>
      </div>
    `;

    const activeAccountId = useAccountStore.getState().activeAccountId;
    if (!activeAccountId || !this.threadId) return;

    this.querySelector("#archive-btn")?.addEventListener("click", () => {
      archiveThread(activeAccountId, this.threadId!, []);
    });

    this.querySelector("#trash-btn")?.addEventListener("click", () => {
      trashThread(activeAccountId, this.threadId!, []);
    });

    this.querySelector("#spam-btn")?.addEventListener("click", () => {
      spamThread(activeAccountId, this.threadId!, [], false);
    });

    this.querySelector("#reply-btn")?.addEventListener("click", () => {
      useComposerStore.getState().openComposer({
        mode: "reply",
        threadId: this.threadId!,
      });
    });
  }
}

customElements.define("velo-action-bar", ActionBarElement);
