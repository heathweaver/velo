import { useShortcutStore } from "@/stores/shortcutStore";

/**
 * The binding currently assigned to an action, formatted for a menu hint.
 *
 * Menus and the command palette used to spell their hints out as literals, so
 * rebinding a shortcut in settings left every hint in the app still advertising
 * the old key — and one of them (snooze) advertised a key that was never bound
 * to anything. Reading the keymap means a hint cannot drift from the binding.
 *
 * Returns undefined for an unknown action so the caller renders no hint rather
 * than an empty one.
 */
export function shortcutFor(actionId: string): string | undefined {
  const binding = useShortcutStore.getState().keyMap[actionId];
  if (!binding) return undefined;
  // "g then i" reads as "g i" in a hint; the settings screen keeps the long
  // form because it is describing how to press it.
  return binding.replace(" then ", " ");
}
