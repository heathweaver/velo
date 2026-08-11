import { create } from "zustand";
import {
  getAllCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  setDefaultCategory,
  type Category,
} from "@/services/db/categories";

/**
 * The categories are workspace-wide and change rarely, so they are loaded once
 * at startup and kept here. Everything that used to import the hardcoded
 * ALL_CATEGORIES list reads this instead, which is what lets a category the
 * user invented show up in the tabs, the context menu, the classifier prompt
 * and the filter actions without any of them knowing about each other.
 */
interface CategoryState {
  categories: Category[];
  loaded: boolean;
  load: () => Promise<void>;
  create: (input: { name: string; description: string; icon?: string | null }) => Promise<void>;
  update: (
    id: string,
    updates: { name?: string; description?: string; icon?: string | null; isEnabled?: boolean },
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  makeDefault: (id: string) => Promise<void>;
}

export const useCategoryStore = create<CategoryState>((set, get) => ({
  categories: [],
  loaded: false,

  load: async () => {
    try {
      set({ categories: await getAllCategories(), loaded: true });
    } catch (err) {
      console.error("Failed to load categories:", err);
    }
  },

  create: async (input) => {
    await createCategory(input);
    await get().load();
  },

  update: async (id, updates) => {
    await updateCategory(id, updates);
    await get().load();
  },

  remove: async (id) => {
    await deleteCategory(id);
    await get().load();
  },

  makeDefault: async (id) => {
    await setDefaultCategory(id);
    await get().load();
  },
}));

/** Categories shown in the UI and offered to the classifier. */
export function getEnabledCategories(): Category[] {
  return useCategoryStore.getState().categories.filter((c) => c.isEnabled);
}

/**
 * The fallback category — what mail gets when nothing else matches.
 *
 * Falls back to the first enabled category if no default is marked, so a
 * misconfigured list still files mail somewhere reachable rather than nowhere.
 */
export function getDefaultCategoryId(): string {
  const categories = useCategoryStore.getState().categories;
  return (
    categories.find((c) => c.isDefault)?.id ??
    categories.find((c) => c.isEnabled)?.id ??
    "Primary"
  );
}
