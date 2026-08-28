/**
 * Sync-window helpers shared by Gmail and IMAP sync paths.
 *
 * `0` means "no date restriction" (sync everything). Callers must not treat
 * `0` as falsy and fall back to a default window.
 */

/** How far back a sync window reaches; `0` / negative = unlimited. */
export function windowReach(days: number | null | undefined): number {
  if (days === null || days === undefined) return 0;
  return days <= 0 ? Number.POSITIVE_INFINITY : days;
}

/** Parse `sync_period_days` from settings. `0` = all mail; default 30 days. */
export function parseSyncPeriodDays(raw: string | null | undefined): number {
  if (raw === null || raw === undefined) return 30;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) return 30;
  return parsed;
}

/**
 * Gmail search query for a sync window, or `undefined` when syncing everything.
 */
export function buildDateQuery(daysBack: number): string | undefined {
  if (daysBack <= 0) return undefined;
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  return `after:${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;
}
