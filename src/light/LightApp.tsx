import { useCallback, useEffect, useMemo, useState } from "react";
import { sanitizeHtml, escapeHtml } from "../utils/sanitize";
import { stripRemoteImages } from "../utils/imageBlocker";
import {
  deleteMessage,
  fetchBody,
  listFolders,
  listMailboxes,
  listMessages,
  moveMessage,
  setFlag,
  type Folder,
  type Mailbox,
  type Msg,
} from "./api";

const FLAGS = { seen: "\\Seen", star: "\\Flagged" } as const;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function findFolder(folders: Folder[], use: string, fallback: RegExp): Folder | undefined {
  return (
    folders.find((f) => f.specialUse === use) ??
    folders.find((f) => fallback.test(f.name))
  );
}

function when(sec: number): string {
  const d = new Date(sec * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function BodyFrame({ msg }: { msg: Msg }) {
  const srcDoc = useMemo(() => {
    const raw = msg.bodyHtml
      ? stripRemoteImages(sanitizeHtml(msg.bodyHtml))
      : `<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(msg.bodyText ?? "")}</pre>`;
    return `<!doctype html><meta charset="utf-8"><base target="_blank"><style>body{font:14px system-ui,sans-serif;color:#222;margin:12px;word-wrap:break-word}img{max-width:100%}</style>${raw}`;
  }, [msg]);
  // Empty sandbox: no scripts, no same-origin access.
  return <iframe title="message" sandbox="" srcDoc={srcDoc} className="w-full h-full border-0 bg-white" />;
}

export function LightApp() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxId, setMailboxId] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState("INBOX");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [lowest, setLowest] = useState<number | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Msg | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phones show one pane at a time (decision #19); md+ shows all three.
  const [showFolders, setShowFolders] = useState(false);

  useEffect(() => {
    listMailboxes()
      .then((m) => {
        setMailboxes(m);
        setMailboxId((cur) => cur ?? m[0]?.id ?? null);
      })
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(() => {
    if (!mailboxId) return;
    setFolders([]);
    listFolders(mailboxId).then(setFolders).catch((e) => setError(errText(e)));
  }, [mailboxId]);

  const load = useCallback(
    async (reset: boolean) => {
      if (!mailboxId) return;
      setLoading(true);
      setError(null);
      try {
        const page = await listMessages(mailboxId, folder, reset ? null : lowest);
        setMessages((cur) => (reset ? page.messages : [...cur, ...page.messages]));
        setLowest(page.lowestUid);
        setMore(page.more);
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoading(false);
      }
    },
    [mailboxId, folder, lowest],
  );

  // Reload the list when the mailbox or folder changes.
  useEffect(() => {
    setOpen(null);
    setMessages([]);
    setLowest(null);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mailboxId, folder]);

  const remove = (uid: number) => {
    setMessages((cur) => cur.filter((m) => m.uid !== uid));
    setOpen(null);
  };

  const openMessage = async (m: Msg) => {
    if (!mailboxId) return;
    setOpen(m);
    try {
      const full = await fetchBody(mailboxId, m.folder, m.uid);
      setOpen({ ...m, ...full });
      if (!m.isRead) {
        await setFlag(mailboxId, m.folder, m.uid, FLAGS.seen, true);
        setMessages((cur) => cur.map((x) => (x.uid === m.uid ? { ...x, isRead: true } : x)));
      }
    } catch (e) {
      setError(errText(e));
    }
  };

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(errText(e));
    }
  };

  const pane = open ? "message" : showFolders ? "folders" : "list";
  const vis = (p: typeof pane, desktop: string) => `${pane === p ? "flex" : "hidden"} md:flex ${desktop}`;
  const folderName = folders.find((f) => f.path === folder)?.name ?? folder;
  const btn = "px-3 py-2 md:px-2 md:py-1 rounded bg-bg-secondary hover:bg-bg-hover";

  const archive = findFolder(folders, "\\Archive", /^archive/i);
  const trash = findFolder(folders, "\\Trash", /^(trash|deleted)/i);

  return (
    <div className="flex h-dvh bg-bg-primary text-text-primary text-sm">
      <aside className={vis("folders", "flex-col w-full md:w-56 shrink-0 md:border-r border-border-primary overflow-y-auto p-2 gap-1")}>
        <select
          className="w-full bg-bg-secondary rounded p-2 md:p-1"
          value={mailboxId ?? ""}
          onChange={(e) => {
            setFolder("INBOX");
            setMailboxId(e.target.value);
          }}
        >
          {mailboxes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName || m.email}
            </option>
          ))}
        </select>
        {folders.map((f) => (
          <button
            key={f.path}
            onClick={() => {
              setFolder(f.path);
              setShowFolders(false);
            }}
            className={`w-full text-left px-3 py-2.5 md:px-2 md:py-1 rounded flex justify-between ${
              f.path === folder ? "bg-bg-selected" : "hover:bg-bg-hover"
            }`}
          >
            <span className="truncate">{f.name}</span>
            {f.unseen > 0 && <span className="text-text-secondary">{f.unseen}</span>}
          </button>
        ))}
        <a href="/?classic=1" className="block px-3 py-2.5 md:px-2 md:py-1 text-text-tertiary hover:underline">
          Settings
        </a>
      </aside>

      <section className={vis("list", "flex-col w-full md:w-80 lg:w-96 shrink-0 md:border-r border-border-primary overflow-y-auto")}>
        <div className="sticky top-0 bg-bg-primary flex items-center justify-between gap-2 p-2 border-b border-border-primary">
          <button
            className="md:hidden px-3 py-2 rounded hover:bg-bg-hover"
            onClick={() => setShowFolders(true)}
            aria-label="Folders"
          >
            ☰
          </button>
          <span className="font-medium truncate flex-1">{folderName}</span>
          <button className="px-3 py-2 md:px-2 md:py-0.5 rounded hover:bg-bg-hover" onClick={() => void load(true)}>
            Refresh
          </button>
        </div>
        {error && <div className="p-2 text-danger">{error}</div>}
        {messages.map((m) => (
          <button
            key={m.uid}
            onClick={() => void openMessage(m)}
            className={`w-full shrink-0 text-left px-3 py-3 md:py-2 border-b border-border-secondary ${
              open?.uid === m.uid ? "bg-bg-selected" : "hover:bg-bg-hover"
            }`}
          >
            <div className="flex justify-between gap-2">
              <span className={`truncate ${m.isRead ? "" : "font-semibold"}`}>
                {m.isStarred ? "★ " : ""}
                {m.fromName || m.fromAddress || "(unknown)"}
              </span>
              <span className="text-text-tertiary shrink-0">{when(m.date)}</span>
            </div>
            <div className={`truncate ${m.isRead ? "text-text-secondary" : ""}`}>
              {m.subject || "(no subject)"}
            </div>
          </button>
        ))}
        {loading && <div className="p-3 text-text-tertiary">Loading…</div>}
        {!loading && more && (
          <button className="w-full p-3 hover:bg-bg-hover" onClick={() => void load(false)}>
            Older
          </button>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="p-3 text-text-tertiary">No messages</div>
        )}
      </section>

      <main className={vis("message", "flex-1 flex-col min-w-0")}>
        {open && mailboxId ? (
          <>
            <div className="p-3 border-b border-border-primary space-y-2">
              <button className="md:hidden -ml-1 px-2 py-1 rounded hover:bg-bg-hover" onClick={() => setOpen(null)}>
                ← {folderName}
              </button>
              <div className="font-medium text-base break-words">{open.subject || "(no subject)"}</div>
              <div className="text-text-secondary break-words">
                {open.fromName} &lt;{open.fromAddress}&gt; · {when(open.date)}
              </div>
              <div className="flex flex-wrap gap-2">
                {archive && (
                  <button
                    className={btn}
                    onClick={() =>
                      void act(() => moveMessage(mailboxId, open.folder, open.uid, archive.path), () => remove(open.uid))
                    }
                  >
                    Archive
                  </button>
                )}
                <button
                  className={btn}
                  onClick={() =>
                    void act(
                      () =>
                        trash && trash.path !== open.folder
                          ? moveMessage(mailboxId, open.folder, open.uid, trash.path)
                          : deleteMessage(mailboxId, open.folder, open.uid),
                      () => remove(open.uid),
                    )
                  }
                >
                  Delete
                </button>
                <button
                  className={btn}
                  onClick={() =>
                    void act(
                      () => setFlag(mailboxId, open.folder, open.uid, FLAGS.star, !open.isStarred),
                      () => {
                        setOpen({ ...open, isStarred: !open.isStarred });
                        setMessages((cur) =>
                          cur.map((x) => (x.uid === open.uid ? { ...x, isStarred: !open.isStarred } : x)),
                        );
                      },
                    )
                  }
                >
                  {open.isStarred ? "Unstar" : "Star"}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <BodyFrame msg={open} />
            </div>
          </>
        ) : (
          <div className="m-auto text-text-tertiary">Select a message</div>
        )}
      </main>
    </div>
  );
}
