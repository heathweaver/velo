/**
 * Email Category Tabs (Web Component)
 * Switches between Primary, Updates, Promotions, Social, and Newsletters.
 */

import { VeloElement } from "../../core/component.ts";
import { router } from "../../router/index.ts";

const CATEGORIES = ["All", "Primary", "Updates", "Promotions", "Social", "Newsletters"];

export class CategoryTabsElement extends VeloElement {
  private activeCategory = "All";

  protected setup(): void {
    this.cleanups.push(
      router.subscribe((state) => {
        if (state.category !== this.activeCategory) {
          this.activeCategory = state.category;
          this.updateTabs();
        }
      }),
    );
  }

  protected render(): void {
    this.className = "flex items-center gap-1 px-3 py-1.5 border-b border-border-primary/50 bg-bg-secondary/40 overflow-x-auto select-none";

    this.innerHTML = CATEGORIES.map((cat) => {
      const isActive = cat === this.activeCategory;
      return `
        <button data-cat="${cat}" class="category-tab px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
          isActive
            ? "bg-bg-primary text-accent shadow-xs font-semibold"
            : "text-text-tertiary hover:text-text-primary hover:bg-bg-hover"
        }">
          ${cat}
        </button>
      `;
    }).join("");

    this.querySelectorAll<HTMLButtonElement>(".category-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cat = btn.dataset.cat || "All";
        router.setCategory(cat);
      });
    });
  }

  private updateTabs(): void {
    this.querySelectorAll<HTMLButtonElement>(".category-tab").forEach((btn) => {
      const isActive = btn.dataset.cat === this.activeCategory;
      btn.classList.toggle("bg-bg-primary", isActive);
      btn.classList.toggle("text-accent", isActive);
      btn.classList.toggle("font-semibold", isActive);
      btn.classList.toggle("shadow-xs", isActive);
      btn.classList.toggle("text-text-tertiary", !isActive);
    });
  }
}

customElements.define("velo-category-tabs", CategoryTabsElement);
