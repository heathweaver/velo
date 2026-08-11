import { render, waitFor } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { EmailRenderer } from "./EmailRenderer";
import type { DbAttachment } from "@/services/db/attachments";

// Mock dependencies
vi.mock("@tauri-apps/plugin-opener", () => ({
  // Returns a promise like the real plugin: the caller attaches .catch to it.
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/sanitize", () => ({
  sanitizeHtml: (html: string) => html,
  escapeHtml: (text: string) => text,
}));

vi.mock("@/services/db/imageAllowlist", () => ({
  addToAllowlist: vi.fn(),
}));

vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: { theme: string }) => string) =>
    selector({ theme: "light" }),
}));

const mockFetchAttachment = vi.fn();

vi.mock("@/services/email/providerFactory", () => ({
  getEmailProvider: vi.fn().mockResolvedValue({
    fetchAttachment: (...args: unknown[]) => mockFetchAttachment(...args),
  }),
}));

// Mock ResizeObserver for jsdom
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

function makeAttachment(overrides: Partial<DbAttachment> = {}): DbAttachment {
  return {
    id: "att-1",
    message_id: "msg-1",
    account_id: "acc-1",
    filename: "icon.png",
    mime_type: "image/png",
    size: 1024,
    gmail_attachment_id: "gmail-att-1",
    content_id: "icon@example.com",
    is_inline: 1,
    local_path: null,
    ...overrides,
  };
}

describe("EmailRenderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders plain text when no html provided", () => {
    const { container } = render(
      <EmailRenderer html={null} text="Hello world" />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("renders html content in iframe", () => {
    const { container } = render(
      <EmailRenderer html="<p>Hello</p>" text={null} />,
    );
    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("resolves cid: references by fetching inline attachment data", async () => {
    const base64Data = btoa("fake-image-data");
    mockFetchAttachment.mockResolvedValue({ data: base64Data, size: 100 });

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "gmail-att-1");
    });

    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("skips cid resolution when no inline attachments", () => {
    render(
      <EmailRenderer
        html='<img src="cid:missing@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={[]}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("skips cid resolution when accountId or messageId missing", () => {
    const inlineAttachments = [makeAttachment()];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  it("handles fetch failure gracefully", async () => {
    mockFetchAttachment.mockRejectedValue(new Error("Network error"));

    const inlineAttachments = [makeAttachment()];

    const { container } = render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalled();
    });

    expect(container.querySelector("iframe")).toBeTruthy();
  });

  it("resolves multiple cid references", async () => {
    mockFetchAttachment
      .mockResolvedValueOnce({ data: btoa("img1"), size: 50 })
      .mockResolvedValueOnce({ data: btoa("img2"), size: 60 });

    const inlineAttachments = [
      makeAttachment({ id: "att-1", content_id: "img1@ex.com", gmail_attachment_id: "g1" }),
      makeAttachment({ id: "att-2", content_id: "img2@ex.com", gmail_attachment_id: "g2", mime_type: "image/jpeg" }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:img1@ex.com" /><img src="cid:img2@ex.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    await waitFor(() => {
      expect(mockFetchAttachment).toHaveBeenCalledTimes(2);
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g1");
      expect(mockFetchAttachment).toHaveBeenCalledWith("msg-1", "g2");
    });
  });

  it("ignores attachments without content_id or gmail_attachment_id", () => {
    const inlineAttachments = [
      makeAttachment({ content_id: null }),
      makeAttachment({ id: "att-2", gmail_attachment_id: null }),
    ];

    render(
      <EmailRenderer
        html='<img src="cid:icon@example.com" />'
        text={null}
        accountId="acc-1"
        messageId="msg-1"
        inlineAttachments={inlineAttachments}
      />,
    );

    expect(mockFetchAttachment).not.toHaveBeenCalled();
  });

  describe("link handling", () => {
    function postFromFrame(container: HTMLElement, data: unknown) {
      const iframe = container.querySelector("iframe")!;
      // jsdom gives the frame a contentWindow; the component identifies its own
      // frame by that window rather than by origin, since a sandboxed frame
      // reports "null".
      window.dispatchEvent(
        new MessageEvent("message", { data, source: iframe.contentWindow }),
      );
    }

    it("opens a link the frame reports", async () => {
      // The frame has to run a script to report anything at all. The previous
      // sandbox (allow-same-origin, no allow-scripts) disabled scripting for
      // that document, so no click was ever observed and links did nothing.
      const { container } = render(<EmailRenderer html="<p>hi</p>" text={null} />);

      postFromFrame(container, { source: "velo-email", type: "link", href: "https://example.com/a" });

      await waitFor(() => {
        expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
      });
    });

    it("opens mailto: links", async () => {
      const { container } = render(<EmailRenderer html="<p>hi</p>" text={null} />);

      postFromFrame(container, { source: "velo-email", type: "link", href: "mailto:a@b.com" });

      await waitFor(() => expect(openUrl).toHaveBeenCalledWith("mailto:a@b.com"));
    });

    it("refuses schemes a mail client should not open", () => {
      // The href is email content, so it is not trusted to name any scheme the
      // OS might route to another application.
      const { container } = render(<EmailRenderer html="<p>hi</p>" text={null} />);

      postFromFrame(container, { source: "velo-email", type: "link", href: "file:///etc/passwd" });

      expect(openUrl).not.toHaveBeenCalled();
    });

    it("ignores messages from anything other than its own frame", () => {
      // Any page in any frame can postMessage to this window.
      render(<EmailRenderer html="<p>hi</p>" text={null} />);

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { source: "velo-email", type: "link", href: "https://evil.example" },
        }),
      );

      expect(openUrl).not.toHaveBeenCalled();
    });

    it("ignores messages that are not ours", () => {
      const { container } = render(<EmailRenderer html="<p>hi</p>" text={null} />);

      postFromFrame(container, { type: "link", href: "https://example.com" });

      expect(openUrl).not.toHaveBeenCalled();
    });

    it("sizes the frame from the height the frame reports", () => {
      // The parent cannot read scrollHeight across an opaque origin, so the
      // height has to arrive by message or the frame collapses.
      const { container } = render(<EmailRenderer html="<p>hi</p>" text={null} />);

      postFromFrame(container, { source: "velo-email", type: "height", height: 420 });

      expect(container.querySelector("iframe")!.style.height).toBe("420px");
    });
  });

  it("sandboxes the frame without same-origin access", () => {
    // allow-scripts with allow-same-origin would let email-borne script reach
    // the app and remove its own sandbox.
    const { container } = render(<EmailRenderer html="<p>hi</p>" text={null} />);
    const sandbox = container.querySelector("iframe")!.getAttribute("sandbox");

    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });
});
