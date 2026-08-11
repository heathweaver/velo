import { useEffect, useRef } from "react";

/**
 * Which spelling of a key combination to produce.
 *
 * `app` matches the in-app binding format parsed by useKeyboardShortcuts
 * ("Ctrl+Shift+E"); `global` matches the OS-level format Tauri's global
 * shortcut plugin expects ("CmdOrCtrl+Shift+E").
 */
export type ShortcutRecorderFormat = "app" | "global";

/**
 * Capture the next key combination the user presses.
 *
 * The recorder listens on window rather than on the button that armed it.
 * Listening on the button is the obvious approach and does not work: on macOS
 * WebKit clicking a button does not focus it, so keydown never reached the
 * handler, the press fell through to the global shortcut handler and ran
 * whatever it was bound to, and no shortcut could be rebound. The blur handler
 * that was meant to disarm the recorder never fired either.
 *
 * The listener runs in the capture phase so the keypress is consumed before
 * the global shortcut handler — also registered on window — can act on it.
 */
export function useShortcutRecorder(
  active: boolean,
  format: ShortcutRecorderFormat,
  onRecord: (binding: string) => void,
  onCancel: () => void,
): void {
  // Held in refs so a new callback identity on each render does not tear down
  // and re-register the listener mid-recording.
  const onRecordRef = useRef(onRecord);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onRecordRef.current = onRecord;
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    if (!active) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key;
      // A modifier on its own is not a binding — wait for the real key.
      if (key === "Control" || key === "Meta" || key === "Shift" || key === "Alt") return;

      e.preventDefault();
      e.stopPropagation();

      if (key === "Escape") {
        onCancelRef.current();
        return;
      }

      const parts: string[] = [];
      if (e.ctrlKey || e.metaKey) parts.push(format === "global" ? "CmdOrCtrl" : "Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");

      // A bare letter stays lowercase, matching the defaults ("j", "k"). With a
      // modifier it is upper-cased, matching "Ctrl+A".
      const withModifier = parts.length > 0 || format === "global";
      parts.push(withModifier && key.length === 1 ? key.toUpperCase() : key);

      onRecordRef.current(parts.join("+"));
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, format]);
}
