use std::sync::{Arc, Mutex, PoisonError};
use tokio::sync::Notify;

#[derive(Default)]
pub(crate) struct ManagerStreams {
    active: Mutex<Option<Arc<Notify>>>,
}

impl ManagerStreams {
    pub(crate) fn claim(&self) -> Option<ManagerStream<'_>> {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if active.is_some() {
            return None;
        }
        let signal = Arc::new(Notify::new());
        *active = Some(Arc::clone(&signal));
        Some(ManagerStream {
            owner: self,
            signal,
        })
    }

    pub(crate) fn disconnect(&self) {
        let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(signal) = active.take() {
            signal.notify_one();
        }
    }
}

pub(crate) struct ManagerStream<'a> {
    owner: &'a ManagerStreams,
    signal: Arc<Notify>,
}

impl ManagerStream<'_> {
    pub(crate) async fn disconnected(&self) {
        self.signal.notified().await;
    }
}

impl Drop for ManagerStream<'_> {
    fn drop(&mut self) {
        let mut active = self
            .owner
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if active
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &self.signal))
        {
            active.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releasing_a_disconnected_stream_never_releases_its_replacement() {
        let state = ManagerStreams::default();
        let first = state.claim().unwrap();
        assert!(state.claim().is_none());
        state.disconnect();
        let replacement = state.claim().unwrap();
        drop(first);
        assert!(state.claim().is_none());
        drop(replacement);
        assert!(state.claim().is_some());
    }
}
