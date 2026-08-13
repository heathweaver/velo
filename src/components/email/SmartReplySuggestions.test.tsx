import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mockIsAiAvailable = vi.fn(() => Promise.resolve(true));
const mockGetSetting = vi.fn(() => Promise.resolve<string | null>("true"));
const mockGenerateSmartReplies = vi.fn(() => Promise.resolve(["Sounds good"]));

vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: () => mockIsAiAvailable(),
}));
vi.mock("@/services/db/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...(args as [])),
}));
vi.mock("@/services/ai/aiService", () => ({
  generateSmartReplies: (...args: unknown[]) => mockGenerateSmartReplies(...(args as [])),
}));
vi.mock("@/services/db/aiCache", () => ({
  deleteAiCache: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/stores/composerStore", () => ({
  useComposerStore: (selector: (s: unknown) => unknown) =>
    selector({ openComposer: vi.fn() }),
}));

import { SmartReplySuggestions } from "./SmartReplySuggestions";
import type { DbMessage } from "@/services/db/messages";

const MESSAGES = [{ id: "m0" } as DbMessage];

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAiAvailable.mockResolvedValue(true);
  mockGetSetting.mockResolvedValue("true");
});

describe("SmartReplySuggestions", () => {
  it("follows the auto-draft setting rather than merely whether AI is configured", async () => {
    // Quick replies used to appear, and generate, whenever an API key existed —
    // there was no setting for them at all, so turning off every AI toggle in
    // settings still produced three billed suggestions per thread opened.
    mockGetSetting.mockResolvedValue("false");

    const { container } = render(
      <SmartReplySuggestions threadId="t1" accountId="a1" messages={MESSAGES} />,
    );

    await waitFor(() => expect(mockGetSetting).toHaveBeenCalledWith("ai_auto_draft_enabled"));
    expect(mockGenerateSmartReplies).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });

  it("renders when auto-draft is on", async () => {
    render(<SmartReplySuggestions threadId="t1" accountId="a1" messages={MESSAGES} />);

    await waitFor(() => expect(mockGenerateSmartReplies).toHaveBeenCalled());
  });

  it("stays quiet when AI is not configured", async () => {
    mockIsAiAvailable.mockResolvedValue(false);

    const { container } = render(
      <SmartReplySuggestions threadId="t1" accountId="a1" messages={MESSAGES} />,
    );

    await waitFor(() => expect(mockIsAiAvailable).toHaveBeenCalled());
    expect(mockGenerateSmartReplies).not.toHaveBeenCalled();
    expect(container.firstChild).toBeNull();
  });
});
