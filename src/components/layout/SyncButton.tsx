import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import { onSyncStatus, triggerSync } from "@/services/gmail/syncManager";

/**
 * Manual sync control for the sidebar.
 *
 * Syncing previously only happened as a side effect of switching folders or on
 * the background timer, so there was no way to ask for mail now and no
 * persistent indication that a sync was under way — only a transient bar at the
 * bottom of the window. This puts both in one place: click to sync, and the
 * icon spins while any account is syncing.
 */
export function SyncButton({ collapsed }: { collapsed: boolean }) {
  const accounts = useAccountStore((s) => s.accounts);
  const [syncing, setSyncing] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    // Track syncing per account so one finishing does not stop the spinner
    // while another is still going.
    const inFlight = new Set<string>();

    return onSyncStatus((accountId, status, _progress, error) => {
      if (status === "syncing") {
        inFlight.add(accountId);
        setLastError(null);
      } else {
        inFlight.delete(accountId);
        // This is the only sync indicator in the window now, so a failure has
        // to be visible here or it is not visible anywhere.
        if (status === "error") setLastError(error ?? "Sync failed");
      }
      setSyncing(inFlight.size > 0);
    });
  }, []);

  const handleSync = () => {
    const activeIds = accounts.filter((a) => a.isActive).map((a) => a.id);
    if (activeIds.length === 0) return;
    setLastError(null);
    triggerSync(activeIds).catch((err) => {
      console.error("Manual sync failed:", err);
    });
  };

  return (
    <button
      onClick={handleSync}
      disabled={syncing}
      title={syncing ? "Syncing…" : lastError ? `Sync failed: ${lastError}` : "Sync now"}
      aria-label={syncing ? "Syncing" : lastError ? "Sync failed — click to retry" : "Sync now"}
      className={`flex items-center justify-center rounded-md p-1.5 transition-colors hover:bg-sidebar-hover disabled:hover:bg-transparent ${
        lastError && !syncing
          ? "text-danger"
          : "text-sidebar-text/60 hover:text-sidebar-text"
      } ${collapsed ? "mx-auto" : ""}`}
    >
      <RefreshCw size={15} className={syncing ? "animate-spin" : ""} />
    </button>
  );
}
