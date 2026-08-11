import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { CSSTransition } from "react-transition-group";
import { useLabelStore } from "@/stores/labelStore";
import { useAccountStore } from "@/stores/accountStore";
import { useThreadStore, accountIdForThread } from "@/stores/threadStore";
import {
  archiveThread,
  trashThread,
  spamThread,
  addThreadLabel,
  removeThreadLabel,
  moveThread,
} from "@/services/emailActions";
import { moveThreadToAccount } from "@/services/crossAccountMove";
import { getLabelsForAccount, type DbLabel } from "@/services/db/labels";
import {
  Inbox,
  Archive,
  Trash2,
  Ban,
  Search,
  Tag,
  Folder,
  AtSign,
} from "lucide-react";

interface MoveToFolderDialogProps {
  isOpen: boolean;
  threadIds: string[];
  onClose: () => void;
}

interface Destination {
  id: string;
  label: string;
  icon: typeof Inbox;
  type: "system" | "label";
  /** For IMAP: the folder path to move to */
  folderPath?: string;
}

const SYSTEM_DESTINATIONS: Destination[] = [
  { id: "INBOX", label: "Inbox", icon: Inbox, type: "system" },
  { id: "__archive__", label: "Archive", icon: Archive, type: "system" },
  { id: "TRASH", label: "Trash", icon: Trash2, type: "system" },
  { id: "SPAM", label: "Spam", icon: Ban, type: "system" },
];

export function MoveToFolderDialog({
  isOpen,
  threadIds,
  onClose,
}: MoveToFolderDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const labels = useLabelStore((s) => s.labels);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);

  // Destination account — defaults to the active (source) account. Choosing a
  // different account turns the operation into a cross-account move/assign.
  const [destAccountId, setDestAccountId] = useState<string | null>(
    activeAccountId,
  );
  const [otherLabels, setOtherLabels] = useState<DbLabel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isCrossAccount =
    destAccountId !== null && destAccountId !== activeAccountId;

  const destAccount = useMemo(
    () => accounts.find((a) => a.id === destAccountId),
    [accounts, destAccountId],
  );
  const isImap = destAccount?.provider === "imap";

  // Load the destination account's folders/labels when it differs from source.
  useEffect(() => {
    if (!isCrossAccount || !destAccountId) {
      setOtherLabels((prev) => (prev.length ? [] : prev));
      return;
    }
    let cancelled = false;
    getLabelsForAccount(destAccountId)
      .then((ls) => {
        if (!cancelled) setOtherLabels(ls.filter((l) => l.type === "user"));
      })
      .catch(() => {
        if (!cancelled) setOtherLabels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isCrossAccount, destAccountId]);

  // Build the full destination list: system destinations + user labels.
  // For cross-account moves only Inbox + real folders make sense.
  const destinations = useMemo(() => {
    const sourceLabels = isCrossAccount
      ? otherLabels.map((l) => ({ id: l.id, name: l.name }))
      : labels.map((l) => ({ id: l.id, name: l.name }));
    const userLabels: Destination[] = sourceLabels.map((l) => ({
      id: l.id,
      label: l.name,
      icon: Tag,
      type: "label" as const,
    }));
    const systemDests = isCrossAccount
      ? [SYSTEM_DESTINATIONS[0]!] // Inbox only
      : SYSTEM_DESTINATIONS;
    return [...systemDests, ...userLabels];
  }, [labels, otherLabels, isCrossAccount]);

  // Filter destinations by search query
  const filtered = useMemo(() => {
    if (!query.trim()) return destinations;
    const q = query.toLowerCase();
    return destinations.filter((d) => d.label.toLowerCase().includes(q));
  }, [destinations, query]);

  const handleSelect = useCallback(
    async (dest: Destination) => {
      if (!activeAccountId || threadIds.length === 0) return;

      // ---- Cross-account move / assign ----
      if (isCrossAccount && destAccountId) {
        setError(null);
        setBusy(true);
        try {
          for (const threadId of threadIds) {
            await moveThreadToAccount(
              activeAccountId,
              threadId,
              destAccountId,
              dest.id, // "INBOX" or folder path / label ID
            );
          }
        } catch (err) {
          setBusy(false);
          setError(
            err instanceof Error
              ? err.message
              : "Failed to move to the other mailbox",
          );
          return;
        }
        setBusy(false);
        onClose();
        window.dispatchEvent(new Event("velo-sync-done"));
        return;
      }

      // ---- Same-account move ----
      onClose();

      for (const threadId of threadIds) {
        if (dest.id === "__archive__") {
          await archiveThread(accountIdForThread(threadId, activeAccountId)!, threadId, []);
        } else if (dest.id === "TRASH") {
          await trashThread(accountIdForThread(threadId, activeAccountId)!, threadId, []);
        } else if (dest.id === "SPAM") {
          await spamThread(accountIdForThread(threadId, activeAccountId)!, threadId, [], true);
        } else if (dest.id === "INBOX") {
          if (isImap) {
            await moveThread(activeAccountId, threadId, [], "INBOX");
          } else {
            // Gmail: add INBOX label (un-archive)
            await addThreadLabel(activeAccountId, threadId, "INBOX");
          }
        } else if (dest.type === "label") {
          if (isImap) {
            // IMAP: move to folder. The label's id is the folder path for IMAP accounts.
            await moveThread(activeAccountId, threadId, [], dest.id);
          } else {
            // Gmail: add destination label + remove from current location (archive)
            await addThreadLabel(activeAccountId, threadId, dest.id);
            // Remove INBOX to complete the "move" semantics
            const thread = useThreadStore
              .getState()
              .threads.find((t) => t.id === threadId);
            if (thread?.labelIds.includes("INBOX")) {
              await removeThreadLabel(activeAccountId, threadId, "INBOX");
            }
          }
        }
      }

      // Refresh thread list
      window.dispatchEvent(new Event("velo-sync-done"));
    },
    [activeAccountId, threadIds, isImap, isCrossAccount, destAccountId, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((prev) => {
          const next = Math.min(prev + 1, filtered.length - 1);
          scrollToIndex(next);
          return next;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((prev) => {
          const next = Math.max(prev - 1, 0);
          scrollToIndex(next);
          return next;
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const dest = filtered[selectedIdx];
        if (dest) {
          handleSelect(dest);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [filtered, selectedIdx, handleSelect, onClose],
  );

  const scrollToIndex = (index: number) => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[index] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: "nearest" });
  };

  // Reset state when dialog opens/closes
  const handleEntered = () => {
    setQuery("");
    setSelectedIdx(0);
    setDestAccountId(activeAccountId);
    setError(null);
    setBusy(false);
    inputRef.current?.focus();
  };

  return (
    <CSSTransition
      in={isOpen}
      timeout={150}
      classNames="modal"
      unmountOnExit
      nodeRef={overlayRef}
      onEntered={handleEntered}
    >
      <div
        ref={overlayRef}
        className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="glass-backdrop absolute inset-0" />
        <div
          className="relative bg-bg-primary border border-border-primary rounded-lg glass-modal w-full max-w-md overflow-hidden"
          onKeyDown={handleKeyDown}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border-secondary">
            <Search size={16} className="text-text-tertiary shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIdx(0);
              }}
              placeholder={
                isCrossAccount ? "Assign to a folder in…" : "Move to..."
              }
              className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
              autoFocus
            />
          </div>

          {/* Destination mailbox selector (only with multiple accounts) */}
          {accounts.length > 1 && (
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-secondary overflow-x-auto">
              <AtSign size={13} className="text-text-tertiary shrink-0" />
              {accounts.map((a) => {
                const isSelected = a.id === destAccountId;
                const isSource = a.id === activeAccountId;
                return (
                  <button
                    key={a.id}
                    className={`shrink-0 px-2 py-0.5 rounded-full text-xs transition-colors cursor-pointer ${
                      isSelected
                        ? "bg-accent text-white"
                        : "bg-bg-tertiary text-text-secondary hover:bg-bg-hover"
                    }`}
                    onClick={() => {
                      setDestAccountId(a.id);
                      setSelectedIdx(0);
                      setError(null);
                    }}
                    title={a.email}
                  >
                    {a.email}
                    {isSource && (
                      <span className="ml-1 opacity-70">(this mailbox)</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Destination list */}
          <div
            ref={listRef}
            className="max-h-64 overflow-y-auto py-1"
            role="listbox"
          >
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-text-tertiary">
                No matching folders or labels
              </div>
            )}
            {filtered.map((dest, idx) => {
              const Icon = dest.type === "system" ? dest.icon : Folder;
              const isSelected = idx === selectedIdx;
              return (
                <button
                  key={dest.id}
                  role="option"
                  aria-selected={isSelected}
                  disabled={busy}
                  className={`flex items-center gap-2.5 w-full px-3 py-1.5 text-sm text-left cursor-pointer transition-colors disabled:opacity-50 ${
                    isSelected
                      ? "bg-bg-selected text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover"
                  }`}
                  onClick={() => handleSelect(dest)}
                  onMouseEnter={() => setSelectedIdx(idx)}
                >
                  <Icon
                    size={15}
                    className={
                      dest.type === "system"
                        ? "text-text-tertiary"
                        : "text-accent"
                    }
                  />
                  <span className="truncate">{dest.label}</span>
                  {dest.type === "system" && (
                    <span className="ml-auto text-[10px] text-text-tertiary uppercase tracking-wider">
                      System
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Error / busy banner */}
          {(error || busy) && (
            <div
              className={`px-3 py-1.5 text-xs border-t border-border-secondary ${
                error ? "text-danger" : "text-text-tertiary"
              }`}
            >
              {busy ? "Moving to the other mailbox…" : error}
            </div>
          )}

          {/* Footer hint */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border-secondary text-[10px] text-text-tertiary">
            <span>
              <kbd className="px-1 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                ↑↓
              </kbd>{" "}
              navigate
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                ↵
              </kbd>{" "}
              select
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                esc
              </kbd>{" "}
              close
            </span>
          </div>
        </div>
      </div>
    </CSSTransition>
  );
}
