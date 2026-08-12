import { getDb, selectFirstBy } from "./connection";

export interface FolderSyncState {
  account_id: string;
  folder_path: string;
  uidvalidity: number | null;
  last_uid: number;
  modseq: number | null;
  last_sync_at: number | null;
  /**
   * The sync window this folder was last walked under, in days (0 = everything).
   *
   * last_uid advances past every message fetched, including the ones the date
   * filter discards, so a folder walked under a narrow window hides everything
   * older behind the high-water mark. Recording the window is what lets a
   * widened setting detect which folders need a rescan. Null means unknown —
   * treated as the narrowest possible, so folders synced before this existed
   * rescan once.
   */
  window_days: number | null;
}

export async function getFolderSyncState(
  accountId: string,
  folderPath: string,
): Promise<FolderSyncState | null> {
  return selectFirstBy<FolderSyncState>(
    "SELECT * FROM folder_sync_state WHERE account_id = $1 AND folder_path = $2",
    [accountId, folderPath],
  );
}

export async function upsertFolderSyncState(
  state: FolderSyncState,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO folder_sync_state (account_id, folder_path, uidvalidity, last_uid, modseq, last_sync_at, window_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT(account_id, folder_path) DO UPDATE SET
       uidvalidity = $3, last_uid = $4, modseq = $5, last_sync_at = $6, window_days = $7`,
    [
      state.account_id,
      state.folder_path,
      state.uidvalidity,
      state.last_uid,
      state.modseq,
      state.last_sync_at,
      state.window_days,
    ],
  );
}

export async function deleteFolderSyncState(
  accountId: string,
  folderPath: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM folder_sync_state WHERE account_id = $1 AND folder_path = $2",
    [accountId, folderPath],
  );
}

export async function clearAllFolderSyncStates(
  accountId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM folder_sync_state WHERE account_id = $1",
    [accountId],
  );
}

export async function getAllFolderSyncStates(
  accountId: string,
): Promise<FolderSyncState[]> {
  const db = await getDb();
  return db.select<FolderSyncState[]>(
    "SELECT * FROM folder_sync_state WHERE account_id = $1 ORDER BY folder_path ASC",
    [accountId],
  );
}
