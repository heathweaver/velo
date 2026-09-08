/**
 * CommandPalette (Web Component)
 * Superhuman-style quick launcher (Ctrl+K).
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { router } from "../../router/index.ts";
import { useComposerStore } from "@/stores/composerStore.ts";
import { useUIStore } from "@/stores/uiStore.ts";

interface CommandItem {
  id: string;
  title: string;
  category: "Navigation" | "Action";
  icon: string;
  action: () => void;
}

const COMMANDS: CommandItem[] = [
  {
    id: "compose",
    title: "Compose New Email",
    category: "Action",
    icon: "plus",
    action: () => useComposerStore.getState().openComposer({ mode: "new" }),
  },
  {
    id: "toggle-dark",
    title: "Toggle Dark / Light Theme",
    category: "Action",
    icon: "sparkles",
    action: () => {
      const current = useUIStore.getState().theme;
      useUIStore.getState().setTheme(current === "dark" ? "light" : "dark");
    },
  },
  {
    id: "go-inbox",
    title: "Go to Inbox",
    category: "Navigation",
    icon: "inbox",
    action: () => router.navigate("/inbox"),
  },
  {
    id: "go-starred",
    title: "Go to Starred",
    category: "Navigation",
    icon: "star",
    action: () => router.navigate("/starred"),
  },
  {
    id: "go-sent",
    title: "Go to Sent",
    category: "Navigation",
    icon: "send",
    action: () => router.navigate("/sent"),
  },
  {
    id: "go-calendar",
    title: "Go to Calendar",
    category: "Navigation",
    icon: "calendar",
    action: () => router.navigate("/calendar"),
  },
  {
    id: "go-tasks",
    title: "Go to Tasks",
    category: "Navigation",
    icon: "tasks",
    action: () => router.navigate("/tasks"),
  },
  {
    id: "go-settings",
    title: "Go to Settings",
    category: "Navigation",
    icon: "settings",
    action: () => router.navigate("/settings"),
  },
];

export class CommandPaletteElement extends VeloElement {
  private isOpen = false;
  private query = "";
  private selectedIndex = 0;

  protected setup(): void {
    this.listen(window, "keydown", (e: Event) => {
      const ke = e as KeyboardEvent;
      if ((ke.ctrlKey || ke.metaKey) && ke.key.toLowerCase() === "k") {
        ke.preventDefault();
        this.toggle();
      } else if (ke.key === "Escape" && this.isOpen) {
        ke.preventDefault();
        this.close();
      }
    });
  }

  toggle(): void {
    this.isOpen = !this.isOpen;
    this.query = "";
    this.selectedIndex = 0;
    this.render();
    if (this.isOpen) {
      setTimeout(() => this.querySelector<HTMLInputElement>("#palette-input")?.focus(), 20);
    }
  }

  close(): void {
    this.isOpen = false;
    this.render();
  }

  protected render(): void {
    if (!this.isOpen) {
      this.className = "hidden";
      this.innerHTML = "";
      return;
    }

    const filtered = COMMANDS.filter((c) =>
      c.title.toLowerCase().includes(this.query.toLowerCase()),
    );

    this.className = "fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50 backdrop-blur-xs select-none";

    this.innerHTML = `
      <div class="w-full max-w-lg bg-bg-primary border border-border-primary rounded-xl shadow-2xl overflow-hidden flex flex-col">
        <!-- Input -->
        <div class="flex items-center px-4 py-3 border-b border-border-primary/50 gap-2.5">
          <span class="text-text-tertiary">${renderIcon("search", "w-4 h-4")}</span>
          <input
            id="palette-input"
            type="text"
            placeholder="Type a command or search..."
            class="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
            value="${this.escapeHtml(this.query)}"
          />
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary font-medium">ESC</span>
        </div>

        <!-- Command List -->
        <div class="max-h-72 overflow-y-auto p-1.5 flex flex-col gap-0.5">
          ${
            filtered.length === 0
              ? `<div class="p-6 text-center text-xs text-text-tertiary">No matching commands</div>`
              : filtered
                  .map(
                    (cmd, idx) => `
                <button
                  data-idx="${idx}"
                  class="command-item flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors text-left cursor-pointer ${
                    idx === this.selectedIndex
                      ? "bg-accent/10 text-accent font-semibold"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }"
                >
                  <div class="flex items-center gap-2.5">
                    <span class="text-text-tertiary">${renderIcon(cmd.icon, "w-4 h-4")}</span>
                    <span>${this.escapeHtml(cmd.title)}</span>
                  </div>
                  <span class="text-[10px] text-text-tertiary">${cmd.category}</span>
                </button>
              `,
                  )
                  .join("")
          }
        </div>
      </div>
    `;

    const input = this.querySelector<HTMLInputElement>("#palette-input");
    input?.addEventListener("input", () => {
      this.query = input.value;
      this.selectedIndex = 0;
      this.render();
      input.focus();
    });

    input?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.selectedIndex =
          this.selectedIndex < filtered.length - 1 ? this.selectedIndex + 1 : 0;
        this.render();
        input.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        this.selectedIndex =
          this.selectedIndex > 0 ? this.selectedIndex - 1 : filtered.length - 1;
        this.render();
        input.focus();
      } else if (e.key === "Enter" && filtered[this.selectedIndex]) {
        e.preventDefault();
        const cmd = filtered[this.selectedIndex];
        this.close();
        cmd.action();
      }
    });

    this.querySelectorAll<HTMLButtonElement>(".command-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const cmd = filtered[idx];
        if (cmd) {
          this.close();
          cmd.action();
        }
      });
    });

    this.addEventListener("click", (e) => {
      if (e.target === this) {
        this.close();
      }
    });
  }
}

customElements.define("velo-command-palette", CommandPaletteElement);
