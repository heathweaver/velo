export interface CategorizationInput {
  labelIds: string[];
  fromAddress: string | null;
  listUnsubscribe: string | null;
  /**
   * Category ids that currently exist. A rule only fires when its answer is one
   * of these — see categorizeByRules.
   */
  knownCategoryIds?: Set<string>;
}

const SOCIAL_DOMAINS = new Set([
  "facebookmail.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "instagram.com",
  "pinterest.com",
  "tiktok.com",
  "reddit.com",
  "snapchat.com",
  "tumblr.com",
  "nextdoor.com",
  "meetup.com",
  "discord.com",
  "mastodon.social",
]);

const NEWSLETTER_DOMAINS = new Set([
  "substack.com",
  "mailchimp.com",
  "convertkit.com",
  "beehiiv.com",
  "buttondown.email",
  "revue.email",
  "ghost.io",
  "tinyletter.com",
  "sendinblue.com",
  "mailerlite.com",
  "campaignmonitor.com",
  "constantcontact.com",
  "getresponse.com",
  "aweber.com",
]);

const PROMO_PREFIXES = new Set([
  "marketing",
  "promo",
  "promotions",
  "deals",
  "offers",
  "sales",
  "shop",
  "store",
  "newsletter",
  "info",
  "hello",
]);

const UPDATE_PREFIXES = new Set([
  "noreply",
  "no-reply",
  "notifications",
  "notification",
  "notify",
  "alerts",
  "alert",
  "donotreply",
  "do-not-reply",
  "mailer-daemon",
  "postmaster",
  "support",
  "billing",
  "account",
  "security",
  "verify",
  "confirm",
]);

function getDomain(email: string): string | null {
  const atIdx = email.lastIndexOf("@");
  if (atIdx === -1) return null;
  return email.slice(atIdx + 1).toLowerCase();
}

function getLocalPart(email: string): string | null {
  const atIdx = email.lastIndexOf("@");
  if (atIdx === -1) return null;
  return email.slice(0, atIdx).toLowerCase();
}

/**
 * Categorize a thread using deterministic rules. No I/O, fully testable.
 *
 * Priority layers:
 * 1. Gmail CATEGORY_* labels
 * 2. Domain heuristics (social domains, newsletter platforms, promo prefixes)
 * 3. List-Unsubscribe header presence
 * 4. Nothing — leave it to the classifier
 *
 * Every layer here is built around Gmail's five tabs: layer 1 is literally
 * Google's own labels. That is fine while the user's categories are still the
 * shipped five, and wrong the moment they define their own — "Promotions" is
 * not a sensible answer for someone whose categories are Reads and Paper
 * Trail. So a rule only answers when the category it names still exists;
 * otherwise it returns null and the AI classifier, which is given the user's
 * actual categories and their descriptions, decides.
 */
export function categorizeByRules(input: CategorizationInput): string | null {
  const known = input.knownCategoryIds;
  const accept = (category: string): string | null =>
    !known || known.has(category) ? category : null;

  // Layer 1: Gmail category labels (highest priority — Google's own ML)
  for (const label of input.labelIds) {
    switch (label) {
      case "CATEGORY_PROMOTIONS":
        return accept("Promotions");
      case "CATEGORY_SOCIAL":
        return accept("Social");
      case "CATEGORY_UPDATES":
        return accept("Updates");
      case "CATEGORY_FORUMS":
        // Forums map to Primary (closest match)
        return accept("Primary");
      case "CATEGORY_PERSONAL":
        return accept("Primary");
    }
  }

  // Layer 2: Domain & address heuristics
  if (input.fromAddress) {
    const domain = getDomain(input.fromAddress);
    const localPart = getLocalPart(input.fromAddress);

    if (domain) {
      // Social networks
      if (SOCIAL_DOMAINS.has(domain)) return accept("Social");

      // Newsletter platforms
      if (NEWSLETTER_DOMAINS.has(domain)) return accept("Newsletters");
    }

    if (localPart) {
      // Promotional prefixes
      if (PROMO_PREFIXES.has(localPart)) return accept("Promotions");

      // Update/notification prefixes
      if (UPDATE_PREFIXES.has(localPart)) return accept("Updates");
    }
  }

  // Layer 3: List-Unsubscribe header
  if (input.listUnsubscribe) {
    // If from a newsletter-ish domain, classify as newsletter
    if (input.fromAddress) {
      const domain = getDomain(input.fromAddress);
      if (domain && NEWSLETTER_DOMAINS.has(domain)) return accept("Newsletters");
    }
    // Generic unsubscribable mail → Promotions
    return accept("Promotions");
  }

  // Layer 4: no rule had an opinion — let the classifier decide
  return null;
}
