import type { DbMessage } from "@/services/db/messages";
import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";

function quoteBody(msg: Pick<DbMessage, "body_html" | "body_text" | "snippet">): string {
  if (msg.body_html) return sanitizeHtml(msg.body_html);
  if (msg.body_text) return escapeHtml(msg.body_text);
  return escapeHtml(msg.snippet ?? "");
}

export function buildQuote(msg: DbMessage): string {
  const date = new Date(msg.date).toLocaleString();
  const from = msg.from_name
    ? `${escapeHtml(msg.from_name)} &lt;${escapeHtml(msg.from_address ?? "")}&gt;`
    : escapeHtml(msg.from_address ?? "Unknown");
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:12px;margin-left:0;color:#666">On ${date}, ${from} wrote:<br>${quoteBody(msg)}</div>`;
}

export function buildForwardQuote(msg: DbMessage): string {
  const date = new Date(msg.date).toLocaleString();
  return `<br><br>---------- Forwarded message ---------<br>From: ${escapeHtml(msg.from_name ?? "")} &lt;${escapeHtml(msg.from_address ?? "")}&gt;<br>Date: ${date}<br>Subject: ${escapeHtml(msg.subject ?? "")}<br>To: ${escapeHtml(msg.to_addresses ?? "")}<br><br>${quoteBody(msg)}`;
}
