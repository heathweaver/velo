//! Per-account priority scheduler for IMAP work.
//!
//! Pooling sessions stopped the reconnect storm, but it did not decide *who
//! goes first*. A background sync walks a mailbox in chunks for minutes at a
//! time; a user deleting a message should not wait behind it, and adding a new
//! account should not stop you sending mail from an existing one.
//!
//! Work is admitted one item at a time per account, and interactive work always
//! jumps ahead of background work. Because sync is already chunked, it releases
//! between chunks — so a user action waits for the current chunk, not the whole
//! mailbox.
//!
//! A plain mutex cannot express this: mutexes have no priority, and a queue of
//! waiters is served in whatever order the runtime happens to wake them.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use tokio::sync::oneshot;

/// How a piece of work ranks against everything else queued for the account.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Priority {
    /// Something the user is waiting for. Always admitted before background work.
    Interactive,
    /// Background sync. Yields to anything interactive.
    Background,
}

impl Priority {
    /// Parse the value carried over the IPC boundary.
    ///
    /// Anything unrecognised — including the absent value from a caller that
    /// predates this — is treated as interactive. Mislabelling a user action as
    /// background would make it wait behind a sync, which is the exact problem
    /// this exists to fix, so the safe default is the impatient one.
    pub fn from_label(label: Option<&str>) -> Self {
        match label {
            Some("background") => Priority::Background,
            _ => Priority::Interactive,
        }
    }
}

#[derive(Default)]
struct AccountState {
    /// Whether someone currently holds the account's turn.
    busy: bool,
    interactive: VecDeque<oneshot::Sender<()>>,
    background: VecDeque<oneshot::Sender<()>>,
}

impl AccountState {
    /// Hand the turn to the next waiter, preferring interactive work.
    ///
    /// Returns false when nobody is waiting, so the caller can mark the account
    /// idle. Senders whose receiver has been dropped (a cancelled caller) are
    /// skipped rather than counted as having been given the turn — otherwise
    /// the account would be left permanently busy with no one holding it.
    fn admit_next(&mut self) -> bool {
        while let Some(waiter) = self
            .interactive
            .pop_front()
            .or_else(|| self.background.pop_front())
        {
            if waiter.send(()).is_ok() {
                return true;
            }
        }
        false
    }
}

#[derive(Default)]
struct SchedulerInner {
    accounts: HashMap<String, AccountState>,
}

/// Admits IMAP work one item at a time per account, interactive first.
#[derive(Clone, Default)]
pub struct Scheduler {
    inner: Arc<Mutex<SchedulerInner>>,
}

/// The right to use an account's connection, released when dropped.
///
/// Release has to happen on drop rather than by an explicit call: the
/// operations that hold a turn are full of `?`, and a turn leaked on an error
/// path would leave that account permanently busy with nobody holding it —
/// every later operation on it would wait forever. That requirement is also
/// why the scheduler's state sits behind a std mutex rather than an async one:
/// `Drop` cannot await.
pub struct Turn {
    scheduler: Scheduler,
    account: String,
}

impl Turn {
    /// Give up the turn. Equivalent to dropping it; reads better at the end of
    /// a long operation.
    pub fn release(self) {}
}

impl Drop for Turn {
    fn drop(&mut self) {
        let mut inner = match self.scheduler.inner.lock() {
            Ok(guard) => guard,
            // A panic elsewhere poisoned the lock. Recovering the state is
            // still better than leaving every account stuck.
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(state) = inner.accounts.get_mut(&self.account) {
            if !state.admit_next() {
                state.busy = false;
            }
        }
    }
}

impl Scheduler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Wait for this account's turn.
    ///
    /// Interactive work is admitted ahead of any background work already
    /// queued — but never interrupts work already running, since an IMAP
    /// command in flight cannot be safely abandoned partway.
    pub async fn acquire(&self, account: &str, priority: Priority) -> Turn {
        let receiver = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let state = inner.accounts.entry(account.to_string()).or_default();

            if !state.busy {
                state.busy = true;
                None
            } else {
                let (tx, rx) = oneshot::channel();
                match priority {
                    Priority::Interactive => state.interactive.push_back(tx),
                    Priority::Background => state.background.push_back(tx),
                }
                Some(rx)
            }
        };

        if let Some(rx) = receiver {
            // A closed channel means the holder vanished without handing the
            // turn on. Proceeding is better than hanging forever.
            let _ = rx.await;
        }

        Turn {
            scheduler: self.clone(),
            account: account.to_string(),
        }
    }

    /// How many items are waiting for this account. For tests and diagnostics.
    pub fn queued(&self, account: &str) -> usize {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        inner
            .accounts
            .get(account)
            .map(|s| s.interactive.len() + s.background.len())
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn unknown_and_missing_labels_are_treated_as_interactive() {
        // A caller that does not label its work must not be filed as
        // background, or a user action would wait behind a sync.
        assert_eq!(Priority::from_label(None), Priority::Interactive);
        assert_eq!(Priority::from_label(Some("")), Priority::Interactive);
        assert_eq!(Priority::from_label(Some("nonsense")), Priority::Interactive);
        assert_eq!(Priority::from_label(Some("background")), Priority::Background);
    }

    #[tokio::test]
    async fn an_idle_account_is_entered_without_waiting() {
        let scheduler = Scheduler::new();
        let turn = scheduler.acquire("acct", Priority::Background).await;
        assert_eq!(scheduler.queued("acct"), 0);
        turn.release();
    }

    #[tokio::test]
    async fn interactive_work_is_admitted_before_queued_background_work() {
        // The point of the whole file: a sync holding the account must not make
        // a user action wait behind every other chunk already queued.
        let scheduler = Scheduler::new();
        let order = Arc::new(Mutex::new(Vec::<&'static str>::new()));

        let held = scheduler.acquire("acct", Priority::Background).await;

        let background = {
            let (s, o) = (scheduler.clone(), order.clone());
            tokio::spawn(async move {
                let turn = s.acquire("acct", Priority::Background).await;
                o.lock().unwrap().push("background");
                turn.release();
            })
        };
        // Let the background waiter queue up first, so priority is what decides
        // the outcome rather than arrival order.
        while scheduler.queued("acct") < 1 {
            tokio::task::yield_now().await;
        }

        let interactive = {
            let (s, o) = (scheduler.clone(), order.clone());
            tokio::spawn(async move {
                let turn = s.acquire("acct", Priority::Interactive).await;
                o.lock().unwrap().push("interactive");
                turn.release();
            })
        };
        while scheduler.queued("acct") < 2 {
            tokio::task::yield_now().await;
        }

        held.release();
        interactive.await.unwrap();
        background.await.unwrap();

        assert_eq!(*order.lock().unwrap(), vec!["interactive", "background"]);
    }

    #[tokio::test]
    async fn accounts_do_not_block_each_other() {
        // Adding an account should not stop you sending from another one.
        let scheduler = Scheduler::new();
        let held = scheduler.acquire("syncing-account", Priority::Background).await;

        let other = scheduler.acquire("other-account", Priority::Interactive).await;
        other.release();

        held.release();
    }

    #[tokio::test]
    async fn every_waiter_eventually_runs() {
        let scheduler = Scheduler::new();
        let ran = Arc::new(AtomicUsize::new(0));
        let held = scheduler.acquire("acct", Priority::Interactive).await;

        let mut handles = Vec::new();
        for i in 0..8 {
            let (s, r) = (scheduler.clone(), ran.clone());
            let priority = if i % 2 == 0 {
                Priority::Background
            } else {
                Priority::Interactive
            };
            handles.push(tokio::spawn(async move {
                let turn = s.acquire("acct", priority).await;
                r.fetch_add(1, Ordering::SeqCst);
                turn.release();
            }));
        }
        while scheduler.queued("acct") < 8 {
            tokio::task::yield_now().await;
        }

        held.release();
        for handle in handles {
            handle.await.unwrap();
        }

        assert_eq!(ran.load(Ordering::SeqCst), 8);
        assert_eq!(scheduler.queued("acct"), 0);
    }

    #[tokio::test]
    async fn a_cancelled_waiter_does_not_strand_the_account() {
        // If a caller gives up while queued, its slot must not be handed the
        // turn and lost — the account would stay busy with nobody holding it.
        let scheduler = Scheduler::new();
        let held = scheduler.acquire("acct", Priority::Interactive).await;

        let abandoned = {
            let s = scheduler.clone();
            tokio::spawn(async move {
                let _turn = s.acquire("acct", Priority::Interactive).await;
            })
        };
        while scheduler.queued("acct") < 1 {
            tokio::task::yield_now().await;
        }
        abandoned.abort();
        let _ = abandoned.await;

        held.release();

        // The account must still be usable.
        let turn = scheduler.acquire("acct", Priority::Interactive).await;
        turn.release();
    }
}
