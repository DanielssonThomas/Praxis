use crate::services::local_host::{self, HostCommand, LaunchStatus};
use std::io;
use std::net::SocketAddrV4;
use std::path::PathBuf;
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::thread::{self, JoinHandle};

pub(crate) struct ManagedHost {
    commands: SyncSender<HostCommand>,
    status: Arc<RwLock<LaunchStatus>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl ManagedHost {
    pub(crate) fn start(root: PathBuf) -> io::Result<Self> {
        let (commands, receive) = mpsc::sync_channel(1);
        let status = Arc::new(RwLock::new(LaunchStatus::Starting));
        let observed = Arc::clone(&status);
        let worker = thread::Builder::new()
            .name("praxis-host-supervisor".into())
            .spawn(move || {
                local_host::supervise(root, receive, |status| {
                    *observed.write().unwrap_or_else(PoisonError::into_inner) = status;
                });
            })?;
        Ok(Self {
            commands,
            status,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub(crate) fn endpoint(&self) -> Option<SocketAddrV4> {
        match self.status() {
            LaunchStatus::Ready(address) => Some(address),
            _ => None,
        }
    }

    pub(crate) fn launch_message(&self) -> Option<&'static str> {
        if self.endpoint().is_some() {
            return None;
        }
        match self.status() {
            LaunchStatus::Starting => Some("Starting the local Praxis host."),
            LaunchStatus::Ready(_) => None,
            LaunchStatus::Failed(message) => Some(message),
        }
    }

    pub(crate) fn retry(&self) -> Result<(), &'static str> {
        match self.commands.try_send(HostCommand::Retry) {
            Ok(()) | Err(TrySendError::Full(_)) => Ok(()),
            Err(TrySendError::Disconnected(_)) => Err("The local Praxis host could not restart."),
        }
    }

    pub(crate) fn shutdown(&self) {
        let _ = self.commands.send(HostCommand::Shutdown);
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    fn status(&self) -> LaunchStatus {
        *self.status.read().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for ManagedHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}
