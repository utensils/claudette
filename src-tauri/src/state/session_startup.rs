use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// Serializes provider selection, spawn and installation for a single chat.
/// Callers can release the global agents lock for I/O without allowing
/// another launcher to reserve a newer generation for the same process slot.
#[derive(Default)]
pub(crate) struct SessionStartup {
    sessions: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

impl SessionStartup {
    pub(crate) async fn acquire(&self, session_id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            sessions.retain(|_, entry| entry.strong_count() > 0);
            let entry = sessions.entry(session_id.to_owned()).or_default();
            entry.upgrade().unwrap_or_else(|| {
                let lock = Arc::new(AsyncMutex::new(()));
                *entry = Arc::downgrade(&lock);
                lock
            })
        };
        lock.lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn overlapping_launchers_share_the_installed_generation() {
        let startup = SessionStartup::default();
        let installed = std::cell::Cell::new(None);
        let first = startup.acquire("chat").await;
        let waiting = async {
            let _guard = startup.acquire("chat").await;
            // Both launch paths inspect the installed process inside the gate.
            installed.get()
        };
        tokio::pin!(waiting);
        tokio::select! {
            biased;
            _ = &mut waiting => panic!("second launcher entered the same chat during spawn"),
            _ = std::future::ready(()) => {}
        }
        let _other = startup.acquire("other").await;
        installed.set(Some(1));
        drop(first);
        assert_eq!(waiting.await, Some(1));
        drop(startup.acquire("third").await);
        assert!(!startup.sessions.lock().unwrap().contains_key("chat"));
    }
}
