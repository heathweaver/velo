import type { NewsletterHighlight, NewsletterSkimInput, NewsletterSkimResult } from "./types";

/**
 * Heuristic newsletter skim.
 *
 * TODO(llm): replace with provider.complete / aiService LLM skim once sync is
 * fast enough that skim does not compete with inbox paint. Keep this signature
 * stable — agents and MCP will call skimNewsletter with the same shape.
 */
export function skimNewsletterHeuristic(input: NewsletterSkimInput): NewsletterSkimResult {
  const topN = input.topN ?? 5;
  const text = normalizeBody(input);
  const highlights: NewsletterHighlight[] = [];

  // Markdown / plaintext headings
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,3}\s+(.+)$/) ?? line.match(/^([A-Z][A-Za-z0-9 ,/&'’-]{8,80})$/);
    if (heading?.[1]) {
      highlights.push({
        title: trimTitle(heading[1]),
        why: "Section heading",
        quote: trimQuote(heading[1]),
      });
    }
    if (highlights.length >= topN) break;
  }

  // HTML headings if we still need slots
  if (highlights.length < topN && input.bodyHtml) {
    const re = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input.bodyHtml)) && highlights.length < topN) {
      const title = stripTags(m[1] ?? "").trim();
      if (title.length < 4) continue;
      highlights.push({
        title: trimTitle(title),
        why: "HTML heading",
        quote: trimQuote(title),
      });
    }
  }

  // Notable links (skip unsubscribe / social chrome)
  if (highlights.length < topN) {
    const linkRe = /\[([^\]]{4,80})\]\((https?:\/\/[^)]+)\)|<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(input.bodyHtml ?? text)) && highlights.length < topN) {
      const title = trimTitle(stripTags(m[1] ?? m[4] ?? "Link"));
      const href = m[2] ?? m[3] ?? "";
      if (/unsubscribe|manage.?pref|view.?in.?browser|facebook|twitter|instagram|linkedin/i.test(title + href)) {
        continue;
      }
      highlights.push({
        title,
        why: "Outbound link",
        quote: trimQuote(href),
      });
    }
  }

  // Fall back to snippet / first paragraph
  if (highlights.length === 0) {
    const fallback = (input.snippet ?? text.split(/\n\n/)[0] ?? input.subject ?? "No content").trim();
    highlights.push({
      title: trimTitle(input.subject ?? "Newsletter"),
      why: "Preview snippet",
      quote: trimQuote(fallback),
    });
  }

  const base = Math.min(1, 0.35 + highlights.length * 0.1);
  const prefBoost = clamp((input.preferenceScore ?? 0) * 0.05, -0.3, 0.3);
  const score = clamp(base + prefBoost, 0, 1);

  return { highlights: highlights.slice(0, topN), score };
}

function normalizeBody(input: NewsletterSkimInput): string {
  if (input.bodyText?.trim()) return input.bodyText;
  if (input.bodyHtml?.trim()) return stripTags(input.bodyHtml);
  return input.snippet ?? "";
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function trimTitle(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

function trimQuote(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 197)}…` : t;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
