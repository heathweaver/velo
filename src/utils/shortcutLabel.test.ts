import { describe, it, expect, beforeEach } from "vitest";
import { useShortcutStore } from "@/stores/shortcutStore";
import { shortcutFor } from "./shortcutLabel";
import { getDefaultKeyMap } from "@/constants/shortcuts";

beforeEach(() => {
  useShortcutStore.setState({ keyMap: getDefaultKeyMap() });
});

describe("shortcutFor", () => {
  it("reports the default binding for an action", () => {
    expect(shortcutFor("action.archive")).toBe("e");
  });

  it("follows a rebinding rather than the shipped default", () => {
    // The whole point: menu hints used to be literals, so rebinding a shortcut
    // left every hint in the app advertising the old key.
    useShortcutStore.getState().setKey("action.archive", "Ctrl+Shift+K");

    expect(shortcutFor("action.archive")).toBe("Ctrl+Shift+K");
  });

  it("shortens a two-key sequence for display", () => {
    expect(shortcutFor("nav.goInbox")).toBe("g i");
  });

  it("returns nothing for an action with no binding", () => {
    // The caller renders no hint at all, rather than an empty one.
    expect(shortcutFor("action.doesNotExist")).toBeUndefined();
  });

  it("has a binding for every action the menus hint at", () => {
    // A menu hinting at an action with no binding is how snooze came to
    // advertise "h", a key bound to nothing.
    for (const id of [
      "action.reply",
      "action.replyAll",
      "action.forward",
      "action.archive",
      "action.delete",
      "action.star",
      "action.snooze",
      "action.pin",
      "action.mute",
      "action.spam",
      "action.moveToFolder",
      "action.unsubscribe",
      "action.createTaskFromEmail",
      "action.compose",
      "nav.escape",
      "nav.goInbox",
      "nav.goStarred",
      "nav.goSent",
      "nav.goDrafts",
      "nav.goTasks",
      "app.toggleSidebar",
    ]) {
      expect(shortcutFor(id), `no binding for ${id}`).toBeDefined();
    }
  });
});
