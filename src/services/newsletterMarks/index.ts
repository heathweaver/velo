export type {
  NewsletterMark,
  NewsletterHighlight,
  NewsletterSkimResult,
  NewsletterSkimInput,
  MarkResult,
} from "./types";
export { skimNewsletterHeuristic } from "./skim";
export {
  applyNewsletterMark,
  applyNewsletterMarkToSender,
  resolveReadsFiling,
} from "./marks";
