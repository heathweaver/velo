import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./api", () => ({
  listMailboxes: vi.fn(async () => [{ id: "m1", email: "a@x.com", displayName: null }]),
  listFolders: vi.fn(async () => [
    { path: "INBOX", name: "INBOX", specialUse: null, exists: 1, unseen: 1 },
    { path: "Archive", name: "Archive", specialUse: "\\Archive", exists: 0, unseen: 0 },
  ]),
  listMessages: vi.fn(async () => ({
    messages: [
      { uid: 7, folder: "INBOX", fromName: "Ann", fromAddress: "ann@x.com", toAddresses: null, subject: "Hello", date: 1700000000, isRead: false, isStarred: false, bodyHtml: null, bodyText: null, snippet: null },
    ],
    lowestUid: 7,
    more: false,
  })),
  fetchBody: vi.fn(async () => ({ bodyText: "hi there", bodyHtml: null })),
  setFlag: vi.fn(async () => null),
  moveMessage: vi.fn(async () => null),
  deleteMessage: vi.fn(async () => null),
}));

import * as api from "./api";
import { LightApp } from "./LightApp";

describe("LightApp", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists messages live and marks one read when opened", async () => {
    render(<LightApp />);
    await waitFor(() => expect(screen.getByText("Hello")).toBeTruthy());
    fireEvent.click(screen.getByText("Hello"));
    await waitFor(() => expect(api.setFlag).toHaveBeenCalledWith("m1", "INBOX", 7, "\\Seen", true));
  });

  it("archives into the special-use Archive folder and removes the row", async () => {
    render(<LightApp />);
    await waitFor(() => screen.getByText("Hello"));
    fireEvent.click(screen.getByText("Hello"));
    const btn = await screen.findByText("Archive", { selector: "button.px-2" });
    fireEvent.click(btn);
    await waitFor(() => expect(api.moveMessage).toHaveBeenCalledWith("m1", "INBOX", 7, "Archive"));
    await waitFor(() => expect(screen.queryByText("Hello")).toBeNull());
  });
});
