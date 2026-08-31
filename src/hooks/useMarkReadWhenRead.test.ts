import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useMarkReadWhenRead } from "./useMarkReadWhenRead";
import { MARK_READ_DELAY_MS } from "@/stores/uiStore";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMarkReadWhenRead", () => {
  it("marks read once the message has been on screen long enough", () => {
    const onMark = vi.fn();
    renderHook(() =>
      useMarkReadWhenRead({ behavior: "delayed", isRead: false, bodyRendered: true, onMark }),
    );

    expect(onMark).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MARK_READ_DELAY_MS);
    expect(onMark).toHaveBeenCalledTimes(1);
  });

  it("leaves a message alone when it is only passed over", () => {
    // The failure this exists for: cursoring down a list of ten with the
    // keyboard marked all ten read.
    const onMark = vi.fn();
    const { unmount } = renderHook(() =>
      useMarkReadWhenRead({ behavior: "delayed", isRead: false, bodyRendered: true, onMark }),
    );

    vi.advanceTimersByTime(MARK_READ_DELAY_MS - 1);
    unmount();
    vi.advanceTimersByTime(MARK_READ_DELAY_MS);

    expect(onMark).not.toHaveBeenCalled();
  });

  it("does not start counting until the body has rendered", () => {
    // A large message takes a moment to lay out; counting from the moment it
    // was opened can run the clock out with nothing yet on screen.
    const onMark = vi.fn();
    const { rerender } = renderHook(
      ({ bodyRendered }) =>
        useMarkReadWhenRead({ behavior: "delayed", isRead: false, bodyRendered, onMark }),
      { initialProps: { bodyRendered: false } },
    );

    vi.advanceTimersByTime(MARK_READ_DELAY_MS * 2);
    expect(onMark).not.toHaveBeenCalled();

    rerender({ bodyRendered: true });
    vi.advanceTimersByTime(MARK_READ_DELAY_MS);
    expect(onMark).toHaveBeenCalledTimes(1);
  });

  it("marks read straight away when asked to", () => {
    const onMark = vi.fn();
    renderHook(() =>
      useMarkReadWhenRead({ behavior: "instant", isRead: false, bodyRendered: false, onMark }),
    );

    expect(onMark).toHaveBeenCalledTimes(1);
  });

  it("never marks read on its own when set to manual", () => {
    const onMark = vi.fn();
    renderHook(() =>
      useMarkReadWhenRead({ behavior: "manual", isRead: false, bodyRendered: true, onMark }),
    );

    vi.advanceTimersByTime(MARK_READ_DELAY_MS * 10);
    expect(onMark).not.toHaveBeenCalled();
  });

  it("leaves an already-read thread alone", () => {
    const onMark = vi.fn();
    renderHook(() =>
      useMarkReadWhenRead({ behavior: "instant", isRead: true, bodyRendered: true, onMark }),
    );

    vi.advanceTimersByTime(MARK_READ_DELAY_MS);
    expect(onMark).not.toHaveBeenCalled();
  });
});
