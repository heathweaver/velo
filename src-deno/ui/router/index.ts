/**
 * Vanilla Client Router for Velo UI.
 * Coordinates view state, active mailbox labels, selected thread, and modal pages.
 */

export interface RouteState {
  view: "mail" | "calendar" | "tasks" | "settings";
  label: string;
  category: string;
  threadId: string | null;
  settingsTab?: string;
}

type RouteListener = (state: RouteState) => void;

class VeloRouter {
  private listeners = new Set<RouteListener>();
  private current: RouteState = {
    view: "mail",
    label: "inbox",
    category: "All",
    threadId: null,
  };

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("hashchange", () => this.handleHashChange());
      this.handleHashChange();
    }
  }

  getState(): RouteState {
    return { ...this.current };
  }

  subscribe(listener: RouteListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  navigate(path: string): void {
    if (typeof window !== "undefined") {
      window.location.hash = path.startsWith("#") ? path : `#${path}`;
    }
  }

  setThread(threadId: string | null): void {
    this.current.threadId = threadId;
    this.notify();
  }

  setCategory(category: string): void {
    this.current.category = category;
    this.notify();
  }

  private handleHashChange(): void {
    const hash = (typeof window !== "undefined" ? window.location.hash.slice(1) : "") || "/inbox";
    const [pathPart, queryPart] = hash.split("?");
    const params = new URLSearchParams(queryPart || "");

    const parts = (pathPart || "/inbox").split("/").filter(Boolean);
    const first = parts[0] || "inbox";

    if (first === "calendar") {
      this.current = { view: "calendar", label: "calendar", category: "All", threadId: null };
    } else if (first === "tasks") {
      this.current = { view: "tasks", label: "tasks", category: "All", threadId: null };
    } else if (first === "settings") {
      this.current = {
        view: "settings",
        label: "settings",
        category: "All",
        threadId: null,
        settingsTab: parts[1] || "general",
      };
    } else {
      // Mail views
      const label = first === "thread" ? "inbox" : first;
      const threadId = first === "thread" ? parts[1] || null : params.get("thread") || null;
      const category = params.get("category") || "All";

      this.current = {
        view: "mail",
        label,
        category,
        threadId,
      };
    }

    this.notify();
  }

  private notify(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

export const router = new VeloRouter();
