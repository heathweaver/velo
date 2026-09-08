/**
 * Composer (Web Component)
 * Rich text email composer with To/CC/BCC, subject, and formatting tools.
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { useComposerStore } from "@/stores/composerStore.ts";
import { useAccountStore } from "@/stores/accountStore.ts";
import { sendEmail } from "@/services/emailActions.ts";
import { buildRawEmail } from "@/utils/emailBuilder.ts";

export class ComposerElement extends VeloElement {
  protected setup(): void {
    this.bindStore(
      useComposerStore,
      (s) => s.isOpen,
      () => this.render(),
    );

    this.bindStore(
      useComposerStore,
      (s) => s.viewMode,
      () => this.render(),
    );
  }

  protected render(): void {
    const { isOpen, viewMode, to, subject, bodyHtml } = useComposerStore.getState();

    if (!isOpen) {
      this.innerHTML = "";
      this.className = "hidden";
      return;
    }

    const isMinimized = viewMode === "minimized";
    const isFullscreen = viewMode === "fullscreen";

    this.className = `fixed z-50 transition-all duration-200 shadow-2xl bg-bg-primary border border-border-primary rounded-xl overflow-hidden flex flex-col ${
      isFullscreen
        ? "inset-4"
        : isMinimized
          ? "bottom-4 right-4 w-72 h-12"
          : "bottom-4 right-4 w-[580px] h-[520px]"
    }`;

    this.innerHTML = `
      <!-- Header -->
      <div class="flex items-center justify-between px-3 py-2 bg-bg-secondary border-b border-border-primary/50 select-none cursor-pointer">
        <span class="text-xs font-semibold text-text-primary truncate">
          ${subject ? this.escapeHtml(subject) : "New Message"}
        </span>
        <div class="flex items-center gap-1 text-text-tertiary">
          <button id="minimize-btn" class="p-1 hover:bg-bg-hover hover:text-text-primary rounded" title="Minimize">
            ${renderIcon("minus", "w-3 h-3")}
          </button>
          <button id="close-btn" class="p-1 hover:bg-danger/20 hover:text-danger rounded" title="Close">
            ${renderIcon("x", "w-3 h-3")}
          </button>
        </div>
      </div>

      ${
        isMinimized
          ? ""
          : `
        <!-- Form Fields -->
        <div class="flex flex-col border-b border-border-primary/40 text-xs">
          <div class="flex items-center px-3 py-1.5 border-b border-border-primary/30">
            <span class="text-text-tertiary w-12 font-medium">To:</span>
            <input
              id="composer-to"
              type="text"
              class="flex-1 bg-transparent text-text-primary focus:outline-none"
              placeholder="recipients@example.com"
              value="${this.escapeHtml(to.join(", "))}"
            />
          </div>

          <div class="flex items-center px-3 py-1.5 border-b border-border-primary/30">
            <span class="text-text-tertiary w-12 font-medium">Subject:</span>
            <input
              id="composer-subject"
              type="text"
              class="flex-1 bg-transparent text-text-primary font-medium focus:outline-none"
              placeholder="Subject"
              value="${this.escapeHtml(subject)}"
            />
          </div>
        </div>

        <!-- Body Editor Area -->
        <div
          id="composer-body"
          contenteditable="true"
          class="flex-1 p-4 text-xs text-text-primary overflow-y-auto focus:outline-none leading-relaxed"
          placeholder="Write your email here..."
        >${bodyHtml || ""}</div>

        <!-- Bottom Action Bar -->
        <div class="flex items-center justify-between px-3 py-2 border-t border-border-primary/50 bg-bg-secondary/20">
          <button id="send-btn" class="flex items-center gap-2 px-4 py-1.5 bg-accent hover:bg-accent-hover text-white rounded-lg text-xs font-semibold shadow-xs transition-colors cursor-pointer">
            ${renderIcon("send", "w-3.5 h-3.5")}
            <span>Send</span>
          </button>

          <div class="flex items-center gap-2 text-text-tertiary">
            <button id="attach-btn" class="p-1.5 hover:bg-bg-hover hover:text-text-primary rounded cursor-pointer" title="Attach file">
              ${renderIcon("paperclip", "w-4 h-4")}
            </button>
            <button id="discard-btn" class="p-1.5 hover:bg-danger/20 hover:text-danger rounded cursor-pointer" title="Discard draft">
              ${renderIcon("trash", "w-4 h-4")}
            </button>
          </div>
        </div>
      `
      }
    `;

    this.querySelector("#close-btn")?.addEventListener("click", () => {
      useComposerStore.getState().closeComposer();
    });

    this.querySelector("#minimize-btn")?.addEventListener("click", () => {
      useComposerStore.getState().setViewMode(isMinimized ? "normal" : "minimized");
    });

    this.querySelector("#discard-btn")?.addEventListener("click", () => {
      useComposerStore.getState().closeComposer();
    });

    const toInput = this.querySelector<HTMLInputElement>("#composer-to");
    toInput?.addEventListener("input", () => {
      const addrs = toInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      useComposerStore.getState().setTo(addrs);
    });

    const subjectInput = this.querySelector<HTMLInputElement>("#composer-subject");
    subjectInput?.addEventListener("input", () => {
      useComposerStore.getState().setSubject(subjectInput.value);
    });

    const bodyEl = this.querySelector<HTMLElement>("#composer-body");
    bodyEl?.addEventListener("input", () => {
      useComposerStore.getState().setBodyHtml(bodyEl.innerHTML);
    });

    this.querySelector("#send-btn")?.addEventListener("click", async () => {
      const activeAccountId = useAccountStore.getState().activeAccountId;
      if (!activeAccountId) {
        alert("No active account selected.");
        return;
      }

      const state = useComposerStore.getState();
      if (!state.to.length) {
        alert("Please add at least one recipient.");
        return;
      }

      try {
        const raw = buildRawEmail({
          to: state.to,
          cc: state.cc,
          bcc: state.bcc,
          subject: state.subject,
          bodyHtml: bodyEl?.innerHTML || state.bodyHtml,
        });

        await sendEmail(activeAccountId, raw);
        useComposerStore.getState().closeComposer();
      } catch (err) {
        console.error("[Composer] Failed to send email:", err);
        alert("Failed to send email: " + (err instanceof Error ? err.message : String(err)));
      }
    });
  }
}

customElements.define("velo-composer", ComposerElement);
