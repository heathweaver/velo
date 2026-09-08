/**
 * EmailRenderer (Web Component)
 * Renders sanitized email HTML inside an isolated, auto-resizing iframe.
 */

import { VeloElement } from "../../core/component.ts";
import DOMPurify from "dompurify";

export class EmailRendererElement extends VeloElement {
  private rawHtml = "";

  setHtml(html: string): void {
    this.rawHtml = html || "<p class='text-text-tertiary italic'>No content</p>";
    this.render();
  }

  protected render(): void {
    this.className = "w-full overflow-hidden my-2";

    const cleanHtml = DOMPurify.sanitize(this.rawHtml, {
      ADD_TAGS: ["style"],
      ADD_ATTR: ["target"],
    });

    const iframe = document.createElement("iframe");
    iframe.sandbox.add("allow-same-origin");
    iframe.className = "w-full border-0 transition-opacity duration-150";
    iframe.style.height = "100px";

    this.innerHTML = "";
    this.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow?.document;
    if (!doc) return;

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
              font-size: 14px;
              line-height: 1.6;
              color: #222;
              margin: 0;
              padding: 4px;
              word-break: break-word;
            }
            @media (prefers-color-scheme: dark) {
              body { color: #ddd; }
              a { color: #818cf8; }
            }
            img { max-width: 100%; height: auto; }
            blockquote {
              border-left: 2px solid #ccc;
              margin-left: 0;
              padding-left: 12px;
              color: #666;
            }
          </style>
        </head>
        <body>${cleanHtml}</body>
      </html>
    `);
    doc.close();

    // Auto-resize iframe height
    const resize = () => {
      if (doc.body) {
        iframe.style.height = `${doc.body.scrollHeight + 16}px`;
      }
    };

    iframe.onload = resize;
    setTimeout(resize, 50);
    setTimeout(resize, 300);
  }
}

customElements.define("velo-email-renderer", EmailRendererElement);
