import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mockIsAiAvailable = vi.fn(() => Promise.resolve(true));
const mockGetSetting = vi.fn(() => Promise.resolve<string | null>("true"));
const mockSummarizeThread = vi.fn(() => Promise.resolve("A summary"));

vi.mock("@/services/ai/providerManager", () => ({
  isAiAvailable: () => mockIsAiAvailable(),
}));
vi.mock("@/services/db/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...(args as [])),
}));
vi.mock("@/services/ai/aiService", () => ({
  summarizeThread: (...args: unknown[]) => mockSummarizeThread(...(args as [])),
}));
vi.mock("@/services/db/aiCache", () => ({
  deleteAiCache: vi.fn(() => Promise.resolve()),
}));

import { ThreadSummary } from "./ThreadSummary";
import type { DbMessage } from "@/services/db/messages";

function messages(count: number): DbMessage[] {
  return Array.from({ length: count }, (_, i) => ({ id: `m${i}` }) as DbMessage);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAiAvailable.mockResolvedValue(true);
  mockGetSetting.mockResolvedValue("true");
});

describe("ThreadSummary", () => {
  it("summarises when the feature is on", async () => {
    render(<ThreadSummary threadId="t1" accountId="a1" messages={messages(2)} />);

    await waitFor(() => expect(mockSummarizeThread).toHaveBeenCalled());
  });

  it("does not call the model when auto-summarise is off", async () => {
    // The toggle used to be decorative: only isAiAvailable was consulted, so
    // opening any thread with two messages billed the user's API key with the
    // feature switched off.
    mockGetSetting.mockResolvedValue("false");

    render(<ThreadSummary threadId="t1" accountId="a1" messages={messages(2)} />);

    await waitFor(() => expect(mockGetSetting).toHaveBeenCalledWith("ai_auto_summarize"));
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });

  it("renders nothing at all when auto-summarise is off", async () => {
    // Not generating is only half of it: with the feature off the panel should
    // not sit at the top of the thread either.
    mockGetSetting.mockResolvedValue("false");

    const { container } = render(
      <ThreadSummary threadId="t1" accountId="a1" messages={messages(2)} />,
    );

    await waitFor(() => expect(mockGetSetting).toHaveBeenCalled());
    expect(container.textContent).not.toContain("AI Summary");
    expect(container.firstChild).toBeNull();
  });

  it("does not call the model when AI is not configured", async () => {
    mockIsAiAvailable.mockResolvedValue(false);

    render(<ThreadSummary threadId="t1" accountId="a1" messages={messages(2)} />);

    await waitFor(() => expect(mockIsAiAvailable).toHaveBeenCalled());
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });

  it("leaves a single-message thread alone", async () => {
    render(<ThreadSummary threadId="t1" accountId="a1" messages={messages(1)} />);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockSummarizeThread).not.toHaveBeenCalled();
  });
});
