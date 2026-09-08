/**
 * Custom Window TitleBar (Web Component)
 * Supports drag region, window action buttons, and network status badge.
 */

import { VeloElement } from "../../core/component.ts";
import { renderIcon } from "../../core/icons.ts";
import { useUIStore } from "@/stores/uiStore.ts";

export class TitleBarElement extends VeloElement {
  protected setup(): void {
    this.bindStore(
      useUIStore,
      (s) => s.isOnline,
      () => this.render(),
    );
  }

  protected render(): void {
    const isOnline = useUIStore.getState().isOnline;

    this.className = "flex items-center justify-between h-10 px-3 select-none border-b border-border-primary bg-bg-secondary/80 backdrop-blur-md";
    this.style.webkitAppRegion = "drag";

    this.innerHTML = `
      <div class="flex items-center gap-2" style="-webkit-app-region: no-drag;">
        <div class="w-3 h-3 rounded-full bg-accent flex items-center justify-center text-[8px] text-white font-bold">V</div>
        <span class="text-xs font-semibold tracking-wide text-text-primary">Velo</span>
        <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
          isOnline ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
        }">
          ${isOnline ? "Online" : "Offline"}
        </span>
      </div>

      <div class="text-xs text-text-tertiary">
        Press <kbd class="px-1.5 py-0.5 text-[10px] bg-bg-tertiary border border-border-secondary rounded">Ctrl+K</kbd> to search
      </div>

      <div class="flex items-center gap-2 text-text-secondary" style="-webkit-app-region: no-drag;">
        <button id="min-btn" class="p-1 hover:bg-bg-hover rounded text-text-tertiary hover:text-text-primary transition-colors" title="Minimize">
          ${renderIcon("minus", "w-3.5 h-3.5")}
        </button>
        <button id="max-btn" class="p-1 hover:bg-bg-hover rounded text-text-tertiary hover:text-text-primary transition-colors" title="Maximize">
          ${renderIcon("square", "w-3 h-3")}
        </button>
        <button id="close-btn" class="p-1 hover:bg-danger/20 hover:text-danger rounded text-text-tertiary transition-colors" title="Close">
          ${renderIcon("x", "w-3.5 h-3.5")}
        </button>
      </div>
    `;

    this.querySelector("#min-btn")?.addEventListener("click", () => {
      console.log("[Window] Minimize");
    });
    this.querySelector("#max-btn")?.addEventListener("click", () => {
      console.log("[Window] Maximize");
    });
    this.querySelector("#close-btn")?.addEventListener("click", () => {
      console.log("[Window] Close");
    });
  }
}

customElements.define("velo-title-bar", TitleBarElement);
