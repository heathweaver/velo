import { useRef, useCallback, useMemo, useState, useEffect } from "react";
import { ImageOff } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { stripRemoteImages, hasBlockedImages } from "@/utils/imageBlocker";
import { addToAllowlist } from "@/services/db/imageAllowlist";
import { escapeHtml, sanitizeHtml } from "@/utils/sanitize";
import { useUIStore } from "@/stores/uiStore";
import type { DbAttachment } from "@/services/db/attachments";

interface EmailRendererProps {
  html: string | null;
  text: string | null;
  blockImages?: boolean;
  senderAddress?: string | null;
  accountId?: string | null;
  senderAllowlisted?: boolean;
  messageId?: string | null;
  inlineAttachments?: DbAttachment[];
}

export function EmailRenderer({
  html,
  text,
  blockImages = false,
  senderAddress,
  accountId,
  senderAllowlisted = false,
  messageId,
  inlineAttachments,
}: EmailRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [overrideShow, setOverrideShow] = useState(false);
  const [cidMap, setCidMap] = useState<Map<string, string>>(new Map());

  const theme = useUIStore((s) => s.theme);
  const isDark = theme === "dark"
    || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  const shouldBlock = blockImages && !senderAllowlisted && !overrideShow;

  // Resolve cid: references by fetching inline attachment data
  useEffect(() => {
    if (!accountId || !messageId || !inlineAttachments?.length) return;

    const cidAttachments = inlineAttachments.filter(
      (a) => a.content_id && a.gmail_attachment_id,
    );
    if (cidAttachments.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const { getEmailProvider } = await import("@/services/email/providerFactory");
        const provider = await getEmailProvider(accountId);
        const resolved = new Map<string, string>();

        await Promise.all(
          cidAttachments.map(async (att) => {
            try {
              const response = await provider.fetchAttachment(
                messageId,
                att.gmail_attachment_id!,
              );
              const base64 = response.data.replace(/-/g, "+").replace(/_/g, "/");
              resolved.set(att.content_id!, `data:${att.mime_type ?? "image/png"};base64,${base64}`);
            } catch {
              // Skip individual failures
            }
          }),
        );

        if (!cancelled && resolved.size > 0) {
          setCidMap(resolved);
        }
      } catch {
        // Non-critical — images just won't render
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, messageId, inlineAttachments]);

  // Sanitize once — reused by both content and blocked-image check
  const sanitizedBody = useMemo(() => {
    if (!html) return null;
    return sanitizeHtml(html);
  }, [html]);

  const isPlainText = !sanitizedBody;

  const bodyHtml = useMemo(() => {
    let body = sanitizedBody
      ?? `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(text ?? "")}</pre>`;

    if (shouldBlock && sanitizedBody) {
      body = stripRemoteImages(body);
    }

    // Replace cid: references with resolved data URIs
    if (cidMap.size > 0) {
      body = body.replace(
        /\bcid:([^"'\s)]+)/gi,
        (match, cidRef: string) => cidMap.get(cidRef) ?? match,
      );
    }

    return body;
  }, [sanitizedBody, text, shouldBlock, cidMap]);

  const blocked = useMemo(() => {
    if (!shouldBlock || !sanitizedBody) return false;
    return hasBlockedImages(stripRemoteImages(sanitizedBody));
  }, [shouldBlock, sanitizedBody]);

  /**
   * The document rendered inside the frame, including the small script that
   * makes it usable.
   *
   * The frame used to be written through `contentDocument` under
   * `sandbox="allow-same-origin"`, with the parent attaching a click listener to
   * the frame's document. That listener was never invoked: a sandbox without
   * `allow-scripts` disables scripting for that document, and WebKit skips
   * listener invocation entirely — so link clicks did nothing, silently, in
   * every configuration. Attaching succeeded, which is why it looked wired up.
   *
   * Now the frame runs its own script under `allow-scripts` *without*
   * `allow-same-origin`, which puts it in an opaque origin: script inside
   * cannot reach the parent document, cookies or storage, and cannot remove its
   * own sandbox. It talks to the parent only through postMessage, reporting its
   * height and any link the reader clicks. The body is DOMPurify output with
   * script tags and event-handler attributes already stripped, so the only
   * script that runs is this one.
   */
  const srcDoc = useMemo(() => {
    // Plain text: blend with app theme (dark text on light bg, light text on dark bg)
    // HTML emails: always render on a light background since senders design for white/light
    const plainTextDark = isDark && isPlainText;
    const htmlDark = isDark && !isPlainText;

    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: ${plainTextDark ? "#e5e7eb" : "#1f2937"};
      background: ${htmlDark ? "#f8f9fa" : "transparent"};
      word-wrap: break-word;
      overflow-wrap: break-word;
      overflow: hidden;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${plainTextDark ? "#60a5fa" : "#3b82f6"}; }
    blockquote {
      border-left: 3px solid ${plainTextDark ? "#4b5563" : "#d1d5db"};
      margin: 8px 0;
      padding: 4px 12px;
      color: ${plainTextDark ? "#9ca3af" : "#6b7280"};
    }
    pre { overflow-x: auto; }
    table { max-width: 100%; }
  </style>
</head>
<body>${bodyHtml}<script>
(function () {
  var send = function (message) {
    // The parent's origin is unknowable from an opaque origin, so the parent
    // identifies this frame by its window rather than by an origin check.
    parent.postMessage(Object.assign({ source: "velo-email" }, message), "*");
  };

  var lastHeight = 0;
  var report = function () {
    var height = document.body.scrollHeight;
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      send({ type: "height", height: height });
    }
  };

  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el.tagName !== "A") el = el.parentElement;
    if (!el || !el.href) return;
    // Nothing in an email should navigate this frame; the parent decides what
    // opening a link means.
    e.preventDefault();
    send({ type: "link", href: el.href });
  });

  report();
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.body);
  window.addEventListener("load", report);
})();
<\/script></body>
</html>`;
  }, [bodyHtml, isDark, isPlainText]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      // Identity, not origin: an opaque-origin frame reports "null" as its
      // origin, so the only sound check is that the message came from this
      // component's own frame.
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;

      const data = e.data as { source?: string; type?: string; height?: number; href?: string };
      if (data?.source !== "velo-email") return;

      if (data.type === "height" && typeof data.height === "number") {
        iframe.style.height = data.height + "px";
        return;
      }

      if (data.type === "link" && typeof data.href === "string") {
        // The href comes from email content, so only schemes a mail client
        // should ever open are honoured — not file:, and not anything the
        // system might hand to another application.
        let scheme: string;
        try {
          scheme = new URL(data.href).protocol;
        } catch {
          return;
        }
        if (scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:") {
          console.warn(`Refused to open link with unsupported scheme: ${scheme}`);
          return;
        }
        openUrl(data.href).catch((err) => {
          console.error("Failed to open link:", err);
        });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const handleLoadImages = useCallback(() => {
    setOverrideShow(true);
  }, []);

  const handleAlwaysLoad = useCallback(async () => {
    if (accountId && senderAddress) {
      await addToAllowlist(accountId, senderAddress);
    }
    setOverrideShow(true);
  }, [accountId, senderAddress]);

  return (
    <div>
      {blocked && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 text-xs bg-bg-tertiary rounded-md border border-border-secondary">
          <ImageOff size={14} className="text-text-tertiary shrink-0" />
          <span className="text-text-secondary">
            Images hidden to protect your privacy.
          </span>
          <button
            onClick={handleLoadImages}
            className="text-accent hover:text-accent-hover font-medium"
          >
            Load images
          </button>
          {senderAddress && accountId && (
            <button
              onClick={handleAlwaysLoad}
              className="text-accent hover:text-accent-hover font-medium"
            >
              Always load from sender
            </button>
          )}
        </div>
      )}
      <iframe
        ref={iframeRef}
        // allow-scripts without allow-same-origin: the frame can run the script
        // above but sits in an opaque origin, so it cannot touch the app.
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className={`w-full border-0 ${isDark && !isPlainText ? "rounded-md" : ""}`}
        style={{ overflow: "hidden" }}
        title="Email content"
      />
    </div>
  );
}

