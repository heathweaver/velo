export type NewsletterMark =
  | "interesting"
  | "noise"
  | "always_reads"
  | "stop";

export interface NewsletterHighlight {
  title: string;
  why: string;
  quote: string;
}

export interface NewsletterSkimResult {
  highlights: NewsletterHighlight[];
  /** 0..1 interestingness estimate */
  score: number;
}

export interface NewsletterSkimInput {
  subject?: string | null;
  fromAddress?: string | null;
  fromName?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string | null;
  /** Optional sender preference from prior marks (−N..+N) */
  preferenceScore?: number;
  /** Max highlights to return (default 5) */
  topN?: number;
}

export interface MarkResult {
  mark: NewsletterMark;
  senderEmail: string;
  message: string;
  filterRuleId?: string | null;
  preferenceScore: number;
}
