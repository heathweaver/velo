import { isNoReplyAddress } from "./noReply";

/**
 * Broad sender classification used to pick the glyph shown beside a sender in
 * the message list. This is presentation only — it never changes what a thread
 * is filed as, and it deliberately uses signals already on the thread rather
 * than fetching or inferring anything new.
 */
export type SenderKind = "person" | "notification" | "feed";

/**
 * Categories come from the existing rule engine / AI categorisation. When a
 * thread has not been categorised, fall back to the sender address: no-reply
 * senders are machines, everything else is treated as a person.
 */
export function senderKind(
  fromAddress: string | null | undefined,
  category?: string,
): SenderKind {
  switch (category) {
    case "Newsletters":
    case "Promotions":
      return "feed";
    case "Updates":
    case "Social":
    case "Forums":
      return "notification";
    case "Primary":
    case "Personal":
      return "person";
  }

  return isNoReplyAddress(fromAddress) ? "notification" : "person";
}
