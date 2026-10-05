import { getDb, boolToInt } from "./connection";

export type NewsletterMarkType = "interesting" | "noise" | "always_reads" | "stop";

export interface DbNewsletterSenderPref {
  id: string;
  account_id: string;
  sender_email: string;
  preference_score: number;
  always_reads: number;
  stopped: number;
  filter_rule_id: string | null;
  updated_at: number;
}

export async function getNewsletterPref(
  accountId: string,
  senderEmail: string,
): Promise<DbNewsletterSenderPref | null> {
  const db = await getDb();
  const rows = await db.select<DbNewsletterSenderPref[]>(
    "SELECT * FROM newsletter_sender_prefs WHERE account_id = $1 AND lower(sender_email) = $2",
    [accountId, senderEmail.toLowerCase()],
  );
  return rows[0] ?? null;
}

export async function getNewsletterPrefsForAccount(
  accountId: string,
): Promise<DbNewsletterSenderPref[]> {
  const db = await getDb();
  return db.select<DbNewsletterSenderPref[]>(
    "SELECT * FROM newsletter_sender_prefs WHERE account_id = $1 ORDER BY updated_at DESC",
    [accountId],
  );
}

export async function upsertNewsletterPref(input: {
  accountId: string;
  senderEmail: string;
  preferenceScore?: number;
  alwaysReads?: boolean;
  stopped?: boolean;
  filterRuleId?: string | null;
}): Promise<string> {
  const db = await getDb();
  const email = input.senderEmail.toLowerCase();
  const existing = await getNewsletterPref(input.accountId, email);
  const now = Date.now();

  if (existing) {
    const score =
      input.preferenceScore !== undefined
        ? input.preferenceScore
        : existing.preference_score;
    const alwaysReads =
      input.alwaysReads !== undefined
        ? boolToInt(input.alwaysReads)
        : existing.always_reads;
    const stopped =
      input.stopped !== undefined ? boolToInt(input.stopped) : existing.stopped;
    const filterRuleId =
      input.filterRuleId !== undefined
        ? input.filterRuleId
        : existing.filter_rule_id;

    await db.execute(
      `UPDATE newsletter_sender_prefs
       SET preference_score = $1, always_reads = $2, stopped = $3,
           filter_rule_id = $4, updated_at = $5
       WHERE id = $6`,
      [score, alwaysReads, stopped, filterRuleId, now, existing.id],
    );
    return existing.id;
  }

  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO newsletter_sender_prefs
      (id, account_id, sender_email, preference_score, always_reads, stopped, filter_rule_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      input.accountId,
      email,
      input.preferenceScore ?? 0,
      boolToInt(input.alwaysReads ?? false),
      boolToInt(input.stopped ?? false),
      input.filterRuleId ?? null,
      now,
    ],
  );
  return id;
}
