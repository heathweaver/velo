import { useState, useEffect, useRef, useCallback } from "react";
import {
  Mail, Clock, X, Send, Copy, Star, UserPlus, Check, PenLine,
  Paperclip, Building2, ChevronDown, ChevronRight, Search,
} from "lucide-react";
import {
  getContactByEmail, getContactStats, getRecentThreadsWithContact,
  upsertContact, updateContact, updateContactNotes,
  getAttachmentsFromContact, getContactsFromSameDomain, getLatestAuthResult,
  type ContactStats, type DbContact, type ContactAttachment, type SameDomainContact,
} from "@/services/db/contacts";
import { isVipSender, addVipSender, removeVipSender } from "@/services/db/notificationVips";
import { getFiltersForAccount, insertFilter, updateFilter, type FilterActions } from "@/services/db/filters";
import { setCategoryForSender } from "@/services/db/threadCategories";
import { useCategoryStore } from "@/stores/categoryStore";
import { getCategoryIcon } from "@/constants/categoryIcons";
import { runSearch } from "@/services/search/runSearch";
import { fetchAndCacheGravatarUrl } from "@/services/contacts/gravatar";
import { useThreadStore } from "@/stores/threadStore";
import { useComposerStore } from "@/stores/composerStore";
import { getThreadById, getThreadLabelIds } from "@/services/db/threads";
import { navigateToThread } from "@/router/navigate";
import { formatRelativeDate } from "@/utils/date";
import { formatFileSize, getFileIcon } from "@/utils/fileTypeHelpers";
import { AuthBadge } from "./AuthBadge";

interface ContactSidebarProps {
  email: string;
  name: string | null;
  accountId: string;
  onClose: () => void;
}

export function ContactSidebar({ email, name, accountId, onClose }: ContactSidebarProps) {
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [stats, setStats] = useState<ContactStats | null>(null);
  const [recentThreads, setRecentThreads] = useState<{ thread_id: string; subject: string | null; last_message_at: number | null }[]>([]);
  const [contact, setContact] = useState<DbContact | null>(null);
  const [isVip, setIsVip] = useState(false);
  const [notes, setNotes] = useState("");
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [attachments, setAttachments] = useState<ContactAttachment[]>([]);
  const [sameDomainContacts, setSameDomainContacts] = useState<SameDomainContact[]>([]);
  const [authResults, setAuthResults] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [addedFeedback, setAddedFeedback] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState("");
  const [contactCategory, setContactCategory] = useState<string | null>(null);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [categoryFeedback, setCategoryFeedback] = useState<string | null>(null);
  const categories = useCategoryStore((s) => s.categories).filter((c) => c.isEnabled);

  const loadedRef = useRef<string | null>(null);
  const notesTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const categoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleThreadClick = useCallback(async (threadId: string) => {
    const { threads, threadMap, setThreads } = useThreadStore.getState();
    if (threadMap.has(threadId)) {
      navigateToThread(threadId);
      return;
    }
    const dbThread = await getThreadById(accountId, threadId);
    if (!dbThread) return;
    const labelIds = await getThreadLabelIds(accountId, threadId);
    const mapped = {
      id: dbThread.id,
      accountId: dbThread.account_id,
      subject: dbThread.subject,
      snippet: dbThread.snippet,
      lastMessageAt: dbThread.last_message_at ?? 0,
      messageCount: dbThread.message_count,
      isRead: dbThread.is_read === 1,
      isStarred: dbThread.is_starred === 1,
      isPinned: dbThread.is_pinned === 1,
      isMuted: dbThread.is_muted === 1,
      hasAttachments: dbThread.has_attachments === 1,
      labelIds,
      fromName: dbThread.from_name,
      fromAddress: dbThread.from_address,
    };
    setThreads([...threads, mapped]);
    navigateToThread(threadId);
  }, [accountId]);

  useEffect(() => {
    if (!email) return;
    loadedRef.current = email;
    let cancelled = false;

    // Load contact + avatar
    getContactByEmail(email).then((c) => {
      if (cancelled) return;
      setContact(c);
      setNotes(c?.notes ?? "");
      if (c?.avatar_url) {
        setAvatarUrl(c.avatar_url);
      } else {
        fetchAndCacheGravatarUrl(email).then((url) => {
          if (!cancelled) setAvatarUrl(url);
        });
      }
    });

    // Load stats
    getContactStats(email).then((s) => { if (!cancelled) setStats(s); });

    // Load recent threads
    getRecentThreadsWithContact(email).then((t) => { if (!cancelled) setRecentThreads(t); });

    // Load VIP status
    isVipSender(accountId, email).then((v) => { if (!cancelled) setIsVip(v); });

    // Load attachments from contact
    getAttachmentsFromContact(email).then((a) => { if (!cancelled) setAttachments(a); });

    // Load same-domain contacts
    getContactsFromSameDomain(email).then((c) => { if (!cancelled) setSameDomainContacts(c); });

    // Load auth results
    getLatestAuthResult(email).then((r) => { if (!cancelled) setAuthResults(r); });

    // Show which category, if any, this sender is already pinned to
    setCategoryFeedback(null);
    getFiltersForAccount(accountId).then((filters) => {
      if (cancelled) return;
      for (const f of filters) {
        try {
          const criteria = JSON.parse(f.criteria_json) as { from?: string };
          const actions = JSON.parse(f.actions_json) as FilterActions;
          if (criteria.from?.toLowerCase() === email.toLowerCase() && actions.setCategory) {
            setContactCategory(actions.setCategory);
            return;
          }
        } catch {
          // Skip malformed rules
        }
      }
      setContactCategory(null);
    });

    return () => { cancelled = true; };
  }, [email, accountId]);

  // -- Event handlers --

  const handleCompose = useCallback(() => {
    useComposerStore.getState().openComposer({ mode: "new", to: [email] });
  }, [email]);

  const handleCopyEmail = useCallback(() => {
    navigator.clipboard.writeText(email);
    setCopyFeedback(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyFeedback(false), 1500);
  }, [email]);

  const handleToggleVip = useCallback(async () => {
    if (isVip) {
      await removeVipSender(accountId, email);
      setIsVip(false);
    } else {
      await addVipSender(accountId, email, name ?? undefined);
      setIsVip(true);
    }
  }, [accountId, email, name, isVip]);

  const handleNotesChange = useCallback((value: string) => {
    setNotes(value);
    if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
    notesTimerRef.current = setTimeout(() => {
      updateContactNotes(email, value);
    }, 1000);
  }, [email]);

  const handleNotesBlur = useCallback(() => {
    if (notesTimerRef.current) {
      clearTimeout(notesTimerRef.current);
      notesTimerRef.current = null;
    }
    updateContactNotes(email, notes);
  }, [email, notes]);

  const handleAddContact = useCallback(async () => {
    await upsertContact(email, name);
    const c = await getContactByEmail(email);
    setContact(c);
    setAddedFeedback(true);
    if (addedTimerRef.current) clearTimeout(addedTimerRef.current);
    addedTimerRef.current = setTimeout(() => setAddedFeedback(false), 1500);
  }, [email, name]);

  /**
   * File every message from this contact under a category, and keep it there.
   *
   * Two halves, and both matter. The filter rule is what makes it stick —
   * without it the classifier re-decides this sender on the next sweep. The
   * backfill is what makes it visible: a rule alone only affects mail that
   * arrives from now on, which reads as the button having done nothing.
   */
  const ruleName = contact?.display_name ?? name ?? email;

  const handleSetCategory = useCallback(async (categoryId: string) => {
    setCategoryBusy(true);
    try {
      const existing = await getFiltersForAccount(accountId);
      const match = existing.find((f) => {
        try {
          const criteria = JSON.parse(f.criteria_json) as { from?: string };
          return criteria.from?.toLowerCase() === email.toLowerCase();
        } catch {
          return false;
        }
      });

      if (match) {
        const actions = JSON.parse(match.actions_json) as FilterActions;
        await updateFilter(match.id, { actions: { ...actions, setCategory: categoryId } });
      } else {
        await insertFilter({
          accountId,
          name: `${ruleName} → ${categoryId}`,
          criteria: { from: email },
          actions: { setCategory: categoryId },
        });
      }

      const affected = await setCategoryForSender(accountId, email, categoryId);
      setContactCategory(categoryId);
      setCategoryFeedback(`${affected} message${affected === 1 ? "" : "s"} filed`);
      window.dispatchEvent(new Event("velo-sync-done"));
    } catch (err) {
      console.error("Failed to set contact category:", err);
      setCategoryFeedback("Failed");
    } finally {
      setCategoryBusy(false);
      if (categoryTimerRef.current) clearTimeout(categoryTimerRef.current);
      categoryTimerRef.current = setTimeout(() => setCategoryFeedback(null), 2500);
    }
  }, [accountId, email, ruleName]);

  /**
   * Hand this contact to the search bar.
   *
   * Deliberately not a bespoke result list: putting `from:` into the real
   * search box means every bulk action the app already has — select all,
   * archive, move, quick steps — works on the result without any of it being
   * reimplemented here.
   */
  const handleSearchAll = useCallback(() => {
    // A higher cap than the search bar's: this button says "all mail from this
    // contact", and a long correspondence easily passes the default.
    runSearch(`from:${email}`, accountId, 500);
  }, [accountId, email]);

  const handleStartEditName = useCallback(() => {
    setEditNameValue(contact?.display_name ?? name ?? "");
    setEditingName(true);
  }, [contact, name]);

  const handleSaveEditName = useCallback(async () => {
    if (!contact) return;
    const trimmed = editNameValue.trim();
    await updateContact(contact.id, trimmed || null);
    setContact({ ...contact, display_name: trimmed || null });
    setEditingName(false);
  }, [contact, editNameValue]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      if (notesTimerRef.current) clearTimeout(notesTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (addedTimerRef.current) clearTimeout(addedTimerRef.current);
      if (categoryTimerRef.current) clearTimeout(categoryTimerRef.current);
    };
  }, []);

  const displayName = contact?.display_name ?? name ?? email.split("@")[0];
  const initial = (displayName?.[0] ?? "?").toUpperCase();
  const domain = email.includes("@") ? email.split("@")[1] : null;

  return (
    <div className="w-72 h-full border-l border-border-primary bg-bg-secondary overflow-y-auto shrink-0">
      <div className="p-4">
        {/* Close button */}
        <div className="flex justify-end -mt-1 -mr-1 mb-1">
          <button
            onClick={onClose}
            title="Close contact sidebar"
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Avatar */}
        <div className="flex flex-col items-center text-center mb-4">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="w-16 h-16 rounded-full mb-2"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-accent/20 text-accent flex items-center justify-center text-xl font-semibold mb-2">
              {initial}
            </div>
          )}

          {/* Name + Auth Badge */}
          {editingName ? (
            <div className="flex items-center gap-1 mb-0.5">
              <input
                type="text"
                value={editNameValue}
                onChange={(e) => setEditNameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveEditName();
                  if (e.key === "Escape") setEditingName(false);
                }}
                autoFocus
                className="w-36 text-sm text-center bg-bg-primary border border-border-primary rounded px-1.5 py-0.5 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                onClick={handleSaveEditName}
                title="Save name"
                className="p-0.5 text-success hover:text-success/80 transition-colors"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-sm font-medium text-text-primary">
              <span>{displayName}</span>
              <AuthBadge authResults={authResults} />
            </div>
          )}

          <div className="text-xs text-text-tertiary mt-0.5">
            {email}
          </div>
        </div>

        {/* Quick Actions Row */}
        <div className="flex items-center justify-center gap-3 mb-4">
          <button
            onClick={handleCompose}
            title="Send email"
            className="p-2 text-text-secondary hover:text-accent hover:bg-bg-hover rounded-lg transition-colors"
          >
            <Send size={16} />
          </button>
          <button
            onClick={handleCopyEmail}
            title={copyFeedback ? "Copied!" : "Copy email"}
            className="p-2 text-text-secondary hover:text-accent hover:bg-bg-hover rounded-lg transition-colors"
          >
            {copyFeedback ? <Check size={16} className="text-success" /> : <Copy size={16} />}
          </button>
          <button
            onClick={handleToggleVip}
            title={isVip ? "Remove VIP" : "Mark as VIP"}
            className={`p-2 rounded-lg transition-colors ${
              isVip
                ? "text-warning hover:text-warning/80 hover:bg-bg-hover"
                : "text-text-secondary hover:text-warning hover:bg-bg-hover"
            }`}
          >
            <Star size={16} fill={isVip ? "currentColor" : "none"} />
          </button>
        </div>

        {/* Add / Edit Contact */}
        {!contact ? (
          <button
            onClick={handleAddContact}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium text-accent border border-accent/30 rounded-md hover:bg-accent/10 transition-colors mb-4"
          >
            {addedFeedback ? (
              <>
                <Check size={12} className="text-success" />
                <span className="text-success">Added!</span>
              </>
            ) : (
              <>
                <UserPlus size={12} />
                <span>Add to Contacts</span>
              </>
            )}
          </button>
        ) : !editingName ? (
          <button
            onClick={handleStartEditName}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-1 text-xs text-text-tertiary hover:text-text-secondary transition-colors mb-4"
          >
            <PenLine size={11} />
            <span>Edit name</span>
          </button>
        ) : null}

        {/* Category */}
        {categories.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              Always file as
            </h4>
            <div className="flex flex-wrap gap-1">
              {categories.map((cat) => {
                const CatIcon = getCategoryIcon(cat.icon);
                const isActive = contactCategory === cat.id;
                return (
                  <button
                    key={cat.id}
                    onClick={() => handleSetCategory(cat.id)}
                    disabled={categoryBusy}
                    title={cat.description || `File mail from ${email} as ${cat.name}`}
                    className={`flex items-center gap-1 px-2 py-1 text-[0.6875rem] rounded-md border transition-colors disabled:opacity-50 ${
                      isActive
                        ? "bg-accent/10 border-accent/40 text-accent"
                        : "border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                    }`}
                  >
                    <CatIcon size={11} />
                    {cat.name}
                  </button>
                );
              })}
            </div>
            <p className="text-[0.625rem] text-text-tertiary mt-1.5">
              {categoryFeedback
                ? categoryFeedback
                : contactCategory
                  ? "Existing and future mail from this sender is filed here."
                  : "Creates a rule and files mail already received."}
            </p>
          </div>
        )}

        {/* Bulk actions */}
        <button
          onClick={handleSearchAll}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 mb-4 text-xs text-text-secondary border border-border-primary rounded-md hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <Search size={12} />
          <span>Search all mail from this contact</span>
        </button>

        {/* Stats */}
        {stats && (
          <div className="space-y-2 mb-4">
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <Mail size={12} className="text-text-tertiary shrink-0" />
              <span>{stats.emailCount} emails</span>
            </div>
            {stats.firstEmail && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Clock size={12} className="text-text-tertiary shrink-0" />
                <span>First email: {formatRelativeDate(stats.firstEmail)}</span>
              </div>
            )}
            {stats.lastEmail && (
              <div className="flex items-center gap-2 text-xs text-text-secondary">
                <Clock size={12} className="text-text-tertiary shrink-0" />
                <span>Last email: {formatRelativeDate(stats.lastEmail)}</span>
              </div>
            )}
          </div>
        )}

        {/* Contact Notes */}
        {contact && (
          <div className="mb-4">
            <button
              onClick={() => setNotesExpanded(!notesExpanded)}
              className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2 hover:text-text-secondary transition-colors"
            >
              {notesExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Notes
            </button>
            {notesExpanded && (
              <textarea
                value={notes}
                onChange={(e) => handleNotesChange(e.target.value)}
                onBlur={handleNotesBlur}
                placeholder="Add a note..."
                rows={3}
                className="w-full text-xs bg-bg-primary border border-border-primary rounded-md px-2 py-1.5 text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y"
              />
            )}
          </div>
        )}

        {/* Shared Files */}
        {attachments.length > 0 && (
          <div className="mb-4">
            <h4 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              <Paperclip size={11} />
              Shared Files
            </h4>
            <div className="space-y-1">
              {attachments.map((att, i) => (
                <div
                  key={`${att.filename}-${att.date}-${i}`}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-bg-hover transition-colors"
                >
                  <span className="shrink-0">{getFileIcon(att.mime_type)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-text-secondary truncate">{att.filename}</div>
                    <div className="text-text-tertiary text-[0.625rem]">
                      {att.size != null && formatFileSize(att.size)}
                      {att.size != null && " \u00B7 "}
                      {formatRelativeDate(att.date)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Same-Domain Contacts */}
        {sameDomainContacts.length > 0 && domain && (
          <div className="mb-4">
            <h4 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              <Building2 size={11} />
              Others at @{domain}
            </h4>
            <div className="space-y-1">
              {sameDomainContacts.map((c) => (
                <div
                  key={c.email}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs rounded hover:bg-bg-hover transition-colors"
                >
                  {c.avatar_url ? (
                    <img src={c.avatar_url} alt="" className="w-5 h-5 rounded-full shrink-0" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-accent/20 text-accent flex items-center justify-center text-[0.5rem] font-semibold shrink-0">
                      {(c.display_name?.[0] ?? c.email[0] ?? "?").toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-text-secondary truncate">
                      {c.display_name ?? c.email.split("@")[0]}
                    </div>
                    <div className="text-text-tertiary text-[0.625rem] truncate">{c.email}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent threads */}
        {recentThreads.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              Recent Conversations
            </h4>
            <div className="space-y-1">
              {recentThreads.map((thread) => (
                <button
                  key={thread.thread_id}
                  onClick={() => handleThreadClick(thread.thread_id)}
                  className="w-full text-left px-2 py-1.5 text-xs rounded hover:bg-bg-hover transition-colors group"
                >
                  <div className="text-text-secondary group-hover:text-text-primary truncate">
                    {thread.subject ?? "(No subject)"}
                  </div>
                  {thread.last_message_at && (
                    <div className="text-text-tertiary text-[0.625rem] mt-0.5">
                      {formatRelativeDate(thread.last_message_at)}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
