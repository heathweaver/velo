import { useEffect } from "react";
import { MARK_READ_DELAY_MS, type MarkAsReadBehavior } from "@/stores/uiStore";

/**
 * Mark a thread read once it has been open, and visible, long enough to have
 * been read.
 *
 * Selection used to be enough: opening a thread marked it read immediately, so
 * moving down a list with the keyboard marked every message it passed over.
 * Ten keystrokes, ten messages read, none of them read.
 *
 * Two things have to be true before the wait even starts. The thread has to be
 * open, and its body has to have rendered — a large message takes a moment to
 * lay out, and counting from the moment it was opened can run the clock out
 * while there is still nothing on screen. Leaving before the wait is up cancels
 * it, which is the point: the message was passed over.
 */
export function useMarkReadWhenRead({
  behavior,
  isRead,
  bodyRendered,
  onMark,
}: {
  behavior: MarkAsReadBehavior;
  /** Already read — nothing to do. */
  isRead: boolean;
  /** The body is on screen. */
  bodyRendered: boolean;
  onMark: () => void;
}): void {
  useEffect(() => {
    if (isRead || behavior === "manual") return;

    if (behavior === "delayed") {
      if (!bodyRendered) return;
      const timer = setTimeout(onMark, MARK_READ_DELAY_MS);
      return () => clearTimeout(timer);
    }

    onMark();
  }, [behavior, isRead, bodyRendered, onMark]);
}
