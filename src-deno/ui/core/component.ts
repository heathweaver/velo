/**
 * Base Web Component class for Velo Vanilla TypeScript UI.
 *
 * Provides:
 * - Automatic subscription cleanup on disconnection (stores, signals, events).
 * - Safe event listener binding.
 * - Reactive store slice binding with shallow equality checks.
 */

export abstract class VeloElement extends HTMLElement {
  protected cleanups: (() => void)[] = [];
  protected isMounted = false;

  connectedCallback(): void {
    this.isMounted = true;
    this.setup();
    this.render();
  }

  disconnectedCallback(): void {
    this.isMounted = false;
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
    this.teardown();
  }

  /**
   * Called once when the element is connected to the DOM before render.
   * Override in subclasses to attach store subscriptions and event listeners.
   */
  protected setup(): void {}

  /**
   * Called when the element is disconnected from the DOM.
   */
  protected teardown(): void {}

  /**
   * Render or update the DOM. Override in subclasses.
   */
  protected abstract render(): void;

  /**
   * Attach an event listener and automatically clean it up on unmount.
   */
  protected listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): () => void {
    target.addEventListener(type, listener, options);
    const cleanup = () => target.removeEventListener(type, listener, options);
    this.cleanups.push(cleanup);
    return cleanup;
  }

  /**
   * Subscribe to a slice of a Zustand store and trigger a callback only when that slice changes.
   */
  protected bindStore<S, T>(
    store: {
      getState: () => S;
      subscribe: (listener: (state: S, prevState: S) => void) => () => void;
    },
    selector: (state: S) => T,
    onChange: (value: T, prevValue: T | undefined) => void,
    fireImmediately = true,
  ): () => void {
    let current = selector(store.getState());
    if (fireImmediately) {
      onChange(current, undefined);
    }

    const unsubscribe = store.subscribe((state) => {
      const next = selector(state);
      if (next !== current) {
        const prev = current;
        current = next;
        onChange(next, prev);
      }
    });

    this.cleanups.push(unsubscribe);
    return unsubscribe;
  }

  /**
   * Helper to escape HTML strings safely.
   */
  protected escapeHtml(str: string | null | undefined): string {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}
