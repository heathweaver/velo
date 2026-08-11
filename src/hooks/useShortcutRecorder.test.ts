import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useShortcutRecorder } from "./useShortcutRecorder";

function press(init: KeyboardEventInit & { key: string }) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

function arm(format: "app" | "global" = "app") {
  const onRecord = vi.fn();
  const onCancel = vi.fn();
  const view = renderHook(
    ({ active }: { active: boolean }) =>
      useShortcutRecorder(active, format, onRecord, onCancel),
    { initialProps: { active: true } },
  );
  return { onRecord, onCancel, ...view };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useShortcutRecorder", () => {
  it("records a key pressed anywhere, not only on a focused button", () => {
    // The recorder used to listen on the button that armed it. macOS WebKit
    // does not focus a button on click, so the key never arrived and no
    // shortcut could be rebound. Nothing is focused here either.
    const { onRecord } = arm();

    press({ key: "b" });

    expect(onRecord).toHaveBeenCalledWith("b");
  });

  it("consumes the keypress so the global shortcut handler does not also run", () => {
    // Without this the recorded key runs its own action mid-recording — press
    // "e" to rebind archive and the thread gets archived.
    const globalHandler = vi.fn();
    window.addEventListener("keydown", globalHandler);
    arm();

    const event = press({ key: "e" });

    expect(globalHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    window.removeEventListener("keydown", globalHandler);
  });

  it("keeps a bare letter lowercase but upper-cases a modified one", () => {
    const { onRecord } = arm();

    press({ key: "j" });
    expect(onRecord).toHaveBeenLastCalledWith("j");

    press({ key: "a", ctrlKey: true, shiftKey: true });
    expect(onRecord).toHaveBeenLastCalledWith("Ctrl+Shift+A");
  });

  it("treats Cmd as Ctrl for in-app bindings", () => {
    const { onRecord } = arm();

    press({ key: ",", metaKey: true });

    expect(onRecord).toHaveBeenCalledWith("Ctrl+,");
  });

  it("spells modifiers the way the OS plugin expects for global shortcuts", () => {
    const { onRecord } = arm("global");

    press({ key: "n", metaKey: true, shiftKey: true });

    expect(onRecord).toHaveBeenCalledWith("CmdOrCtrl+Shift+N");
  });

  it("waits for a real key rather than recording a lone modifier", () => {
    const { onRecord } = arm();

    press({ key: "Shift", shiftKey: true });
    press({ key: "Meta", metaKey: true });

    expect(onRecord).not.toHaveBeenCalled();
  });

  it("cancels on Escape instead of binding it", () => {
    const { onRecord, onCancel } = arm();

    press({ key: "Escape" });

    expect(onCancel).toHaveBeenCalled();
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("stops listening once disarmed", () => {
    const { onRecord, rerender } = arm();

    rerender({ active: false });
    press({ key: "b" });

    expect(onRecord).not.toHaveBeenCalled();
  });
});
