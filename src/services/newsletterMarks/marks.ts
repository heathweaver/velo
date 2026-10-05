import {
  getFiltersForAccount,
  insertFilter,
  updateFilter,
  type FilterActions,
  type FilterCriteria,
} from "@/services/db/filters";
import { getLabelsForAccount } from "@/services/db/labels";
import { getAllCategories } from "@/services/db/categories";
import {
  getNewsletterPref,
  upsertNewsletterPref,
} from "@/services/db/newsletterPrefs";
import { getMessagesForThread } from "@/services/db/messages";
import type { MarkResult, NewsletterMark } from "./types";

const MARKS_RULE_PREFIX = "Newsletter mark:";

/**
 * Apply a newsletter mark to the sender of a thread.
 *
 * Resolves the From address from the newest message in the thread, upserts
 * preference state, and creates/updates filter rules where the mark calls for
 * lasting mail treatment.
 */
export async function applyNewsletterMark(
  accountId: string,
  threadId: string,
  mark: NewsletterMark,
): Promise<MarkResult> {
  const senderEmail = await resolveSenderEmail(accountId, threadId);
  if (!senderEmail) {
    throw new Error("No sender address on this thread");
  }
  return applyNewsletterMarkToSender(accountId, senderEmail, mark);
}

export async function applyNewsletterMarkToSender(
  accountId: string,
  senderEmail: string,
  mark: NewsletterMark,
): Promise<MarkResult> {
  const email = senderEmail.toLowerCase();
  const existing = await getNewsletterPref(accountId, email);
  let preferenceScore = existing?.preference_score ?? 0;
  let filterRuleId: string | null = existing?.filter_rule_id ?? null;
  let message: string;

  switch (mark) {
    case "interesting": {
      preferenceScore += 1;
      await upsertNewsletterPref({
        accountId,
        senderEmail: email,
        preferenceScore,
        stopped: false,
        filterRuleId,
      });
      if (existing?.stopped) {
        await setSenderRulesEnabled(accountId, email, true);
      }
      message = `Interesting — boosted ${email} (score ${preferenceScore})`;
      break;
    }
    case "noise": {
      preferenceScore -= 1;
      filterRuleId = await upsertSenderFilter(accountId, email, {
        name: `${MARKS_RULE_PREFIX} Noise ${email}`,
        actions: { archive: true, markRead: true },
        existingRuleId: filterRuleId,
      });
      await upsertNewsletterPref({
        accountId,
        senderEmail: email,
        preferenceScore,
        stopped: false,
        alwaysReads: false,
        filterRuleId,
      });
      message = `Noise — demoted ${email}; future mail archived+read`;
      break;
    }
    case "always_reads": {
      const filing = await resolveReadsFiling(accountId);
      filterRuleId = await upsertSenderFilter(accountId, email, {
        name: `${MARKS_RULE_PREFIX} Always Reads ${email}`,
        actions: filing.actions,
        existingRuleId: filterRuleId,
      });
      await upsertNewsletterPref({
        accountId,
        senderEmail: email,
        preferenceScore,
        alwaysReads: true,
        stopped: false,
        filterRuleId,
      });
      message = filing.message.replace("filing", `filing ${email} into`);
      break;
    }
    case "stop": {
      await setSenderRulesEnabled(accountId, email, false);
      await upsertNewsletterPref({
        accountId,
        senderEmail: email,
        preferenceScore,
        stopped: true,
        alwaysReads: false,
        filterRuleId,
      });
      message = `Stop — disabled auto-treat rules for ${email}`;
      break;
    }
  }

  return { mark, senderEmail: email, message, filterRuleId, preferenceScore };
}

async function resolveSenderEmail(
  accountId: string,
  threadId: string,
): Promise<string | null> {
  const messages = await getMessagesForThread(accountId, threadId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const addr = messages[i]?.from_address?.trim();
    if (addr) return addr.toLowerCase();
  }
  return null;
}

/**
 * Prefer a Reads label/folder; otherwise interim category filing.
 * Server-side MOVE into IMAP Reads remains the real target (see spec).
 */
export async function resolveReadsFiling(accountId: string): Promise<{
  actions: FilterActions;
  message: string;
}> {
  const labels = await getLabelsForAccount(accountId);
  const readsLabel =
    labels.find((l) => l.name.toLowerCase() === "reads") ??
    labels.find((l) => /(^|[./])reads$/i.test(l.name));

  if (readsLabel) {
    return {
      actions: { applyLabel: readsLabel.id },
      message: `Always Reads — filing via label/folder ${readsLabel.name} (server MOVE is the long-term path)`,
    };
  }

  const categories = await getAllCategories();
  const readsCat = categories.find(
    (c) => c.id === "Reads" || c.name.toLowerCase() === "reads",
  );
  const categoryId = readsCat?.id ?? "Newsletters";

  return {
    actions: { setCategory: categoryId },
    message: `Always Reads — no IMAP Reads folder; interim category ${categoryId} (server MOVE to Reads when filer is on)`,
  };
}

async function upsertSenderFilter(
  accountId: string,
  senderEmail: string,
  opts: {
    name: string;
    actions: FilterActions;
    existingRuleId: string | null;
  },
): Promise<string> {
  const criteria: FilterCriteria = { from: senderEmail };

  if (opts.existingRuleId) {
    await updateFilter(opts.existingRuleId, {
      name: opts.name,
      criteria,
      actions: opts.actions,
      isEnabled: true,
    });
    return opts.existingRuleId;
  }

  const existing = await getFiltersForAccount(accountId);
  const match = existing.find((f) => {
    try {
      const c = JSON.parse(f.criteria_json) as FilterCriteria;
      return c.from?.toLowerCase() === senderEmail.toLowerCase();
    } catch {
      return false;
    }
  });

  if (match) {
    const prev = JSON.parse(match.actions_json) as FilterActions;
    await updateFilter(match.id, {
      name: opts.name,
      actions: { ...prev, ...opts.actions },
      isEnabled: true,
    });
    return match.id;
  }

  return insertFilter({
    accountId,
    name: opts.name,
    criteria,
    actions: opts.actions,
    isEnabled: true,
  });
}

async function setSenderRulesEnabled(
  accountId: string,
  senderEmail: string,
  enabled: boolean,
): Promise<void> {
  const filters = await getFiltersForAccount(accountId);
  for (const f of filters) {
    try {
      const c = JSON.parse(f.criteria_json) as FilterCriteria;
      if (c.from?.toLowerCase() !== senderEmail.toLowerCase()) continue;
      await updateFilter(f.id, { isEnabled: enabled });
    } catch {
      // skip corrupt rule
    }
  }
}
