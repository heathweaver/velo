import { getDb } from "../db/connection";
import { withTransaction } from "../db/connection";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { createBackgroundChecker } from "../backgroundCheckers";
import { resolveSnoozeDestination } from "./snoozeDestination";
import {
  moveThread,
  addThreadLabel,
  removeThreadLabel,
  archiveThread,
} from "../emailActions";

/**
 * Check for snoozed threads that should be un-snoozed (time has passed).
 * Moves them back to INBOX.
 */
async function checkSnoozedThreads(): Promise<void> {
  const db = await getDb();
  const now = getCurrentUnixTimestamp();

  // Find threads where snooze time has passed
  const snoozed = await db.select<
    { id: string; account_id: string }[]
  >(
    "SELECT id, account_id FROM threads WHERE is_snoozed = 1 AND snooze_until <= $1",
    [now],
  );

  if (snoozed.length === 0) return;

  let restored = 0;
  for (const thread of snoozed) {
    try {
      await unsnoozeThread(thread.account_id, thread.id);
      restored++;
    } catch (err) {
      // Leave it snoozed and try again on the next tick. Clearing the flag
      // after a failed move would strand the mail in the snooze folder with
      // nothing left to bring it back.
      console.error(`Failed to un-snooze thread ${thread.id}:`, err);
    }
  }

  if (restored > 0) {
    window.dispatchEvent(new Event("velo-sync-done"));
  }
}

/**
 * Snooze a thread until a given time.
 *
 * The thread is moved out of the inbox *on the server*, not just locally.
 * Sync rewrites labels from what the server reports, so a locally-removed
 * INBOX label was restored on the very next pass and the mail came straight
 * back — the reason snooze appeared not to work at all. Moving it server-side
 * also means the snooze is visible on every other device, which is the whole
 * point of the feature.
 *
 * Throws when the account has nowhere to park snoozed mail, so the caller can
 * say so rather than silently doing nothing.
 */
export async function snoozeThread(
  accountId: string,
  threadId: string,
  snoozeUntil: number,
): Promise<void> {
  const destination = await resolveSnoozeDestination(accountId);
  if (!destination) {
    throw new Error(
      "This account has no Snoozed or Later folder. Create one in your mailbox to enable snoozing.",
    );
  }

  if (destination.kind === "folder") {
    await moveThread(accountId, threadId, [], destination.folderPath);
  } else {
    await addThreadLabel(accountId, threadId, destination.labelId);
    await archiveThread(accountId, threadId, []);
  }

  await withTransaction(async (db) => {
    await db.execute(
      "UPDATE threads SET is_snoozed = 1, snooze_until = $1 WHERE account_id = $2 AND id = $3",
      [snoozeUntil, accountId, threadId],
    );
  });
}

/**
 * Put a snoozed thread back in the inbox, on the server as well as locally.
 */
async function unsnoozeThread(accountId: string, threadId: string): Promise<void> {
  const destination = await resolveSnoozeDestination(accountId);

  if (destination?.kind === "folder") {
    await moveThread(accountId, threadId, [], "INBOX");
  } else {
    await addThreadLabel(accountId, threadId, "INBOX");
    if (destination) {
      await removeThreadLabel(accountId, threadId, destination.labelId);
    }
  }

  await withTransaction(async (db) => {
    await db.execute(
      "UPDATE threads SET is_snoozed = 0, snooze_until = NULL WHERE account_id = $1 AND id = $2",
      [accountId, threadId],
    );
  });
}

const snoozeChecker = createBackgroundChecker("Snooze", checkSnoozedThreads);
export const startSnoozeChecker = snoozeChecker.start;
export const stopSnoozeChecker = snoozeChecker.stop;
