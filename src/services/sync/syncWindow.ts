/**
 * Sync-window comparison, shared by the IMAP and Gmail sync paths.
 *
 * Both providers keep a high-water mark — per-folder UIDs on IMAP, a history id
 * on Gmail — and both only ever move it forward. Neither can honour a widened
 * window by asking for what is new, because the mail that is missing is older
 * than the mark. Both therefore need to know when the window has widened so
 * they can start again.
 */

/**
 * How far back a sync window reaches, for comparing two of them.
 *
 * 0 means "everything", so it sorts above every finite window.
 */
export function windowReach(days: number | null | undefined): number {
  if (days === null || days === undefined) return 0;
  return days <= 0 ? Number.POSITIVE_INFINITY : days;
}

/**
 * Whether a folder has to be walked from the beginning again.
 *
 * last_uid advances past every message fetched, including the ones the date
 * filter discarded, so a folder walked under a narrow window has everything
 * older sitting below the high-water mark where delta sync will never look.
 * Widening the window therefore cannot be honoured by asking for new UIDs — the
 * missing mail is *older*, not newer, and the folder needs a full pass.
 *
 * A folder with no recorded window predates this being tracked, so it is
 * treated as the narrowest possible and rescanned once.
 */
export function needsFullRescan(
  storedWindowDays: number | null | undefined,
  currentWindowDays: number,
): boolean {
  return windowReach(currentWindowDays) > windowReach(storedWindowDays);
}
