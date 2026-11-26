use std::io::{self, BufRead, BufReader, Read};
use std::net::{Ipv4Addr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

const CHECK_INTERVAL: Duration = Duration::from_millis(80);
const STARTUP_LIMIT: Duration = Duration::from_secs(8);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const READINESS_PREFIX: &str = "Praxis at http://127.0.0.1:";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LaunchStatus {
    Starting,
    Ready(SocketAddrV4),
    Failed(&'static str),
}

pub(crate) enum HostCommand {
    Retry,
    Shutdown,
}

pub(crate) fn supervise(
    root: PathBuf,
    commands: Receiver<HostCommand>,
    publish: impl Fn(LaunchStatus),
) {
    let mut child = launch(&root, &publish);
    loop {
        match commands.recv_timeout(CHECK_INTERVAL) {
            Ok(HostCommand::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(HostCommand::Retry) if child.is_none() => child = launch(&root, &publish),
            Ok(HostCommand::Retry) | Err(RecvTimeoutError::Timeout) => {}
        }
        if let Some(owned) = &mut child {
            match owned.check() {
                Ok(Some(address)) => publish(LaunchStatus::Ready(address)),
                Ok(None) => {}
                Err(message) => {
                    if let Some(owned) = child.take() {
                        owned.stop();
                    }
                    publish(LaunchStatus::Failed(message));
                }
            }
        }
    }
    if let Some(owned) = child {
        owned.stop();
    }
}

fn launch(root: &Path, publish: &impl Fn(LaunchStatus)) -> Option<OwnedHost> {
    publish(LaunchStatus::Starting);
    match OwnedHost::spawn(root) {
        Ok(child) => Some(child),
        Err(message) => {
            publish(LaunchStatus::Failed(message));
            None
        }
    }
}

type Readiness = Result<SocketAddrV4, &'static str>;

struct OwnedHost {
    child: Child,
    started: Instant,
    readiness: Option<Receiver<Readiness>>,
}

impl OwnedHost {
    fn spawn(root: &Path) -> Result<Self, &'static str> {
        let node = root.join("bin/node");
        let entrypoint = root.join("app/dist/cli.js");
        if !node.is_file() || !entrypoint.is_file() {
            return Err("The local Praxis host resources are missing.");
        }
        let mut child = Command::new(node)
            .arg(entrypoint)
            .current_dir(root)
            .env("PRAXIS_DESKTOP_HOST", "1")
            .env("PRAXIS_PORT", "0")
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "The local Praxis host could not start.")?;

        let output = child.stdout.take();
        let (send, receive) = mpsc::sync_channel(1);
        let reader = thread::Builder::new()
            .name("praxis-host-readiness".into())
            .spawn(move || {
                let Some(output) = output else { return };
                let mut output = BufReader::new(output);
                let mut line = String::new();
                let parsed = output
                    .by_ref()
                    .take(128)
                    .read_line(&mut line)
                    .ok()
                    .and_then(|_| parse_readiness(&line));
                let _ = send.send(parsed.ok_or("The local Praxis host did not report readiness."));
                let _ = io::copy(&mut output, &mut io::sink());
            });
        let owned = Self {
            child,
            started: Instant::now(),
            readiness: Some(receive),
        };
        if reader.is_err() {
            owned.stop();
            return Err("The local Praxis host could not start.");
        }
        Ok(owned)
    }

    fn check(&mut self) -> Result<Option<SocketAddrV4>, &'static str> {
        match self.child.try_wait() {
            Ok(Some(_)) => return Err("The local Praxis host stopped."),
            Err(_) => return Err("The local Praxis host could not be monitored."),
            Ok(None) => {}
        }
        let Some(readiness) = &self.readiness else {
            return Ok(None);
        };
        match readiness.try_recv() {
            Ok(result) => {
                self.readiness = None;
                result.map(Some)
            }
            Err(TryRecvError::Empty) if self.started.elapsed() < STARTUP_LIMIT => Ok(None),
            Err(TryRecvError::Empty) => Err("The local Praxis host took too long to start."),
            Err(TryRecvError::Disconnected) => {
                Err("The local Praxis host did not report readiness.")
            }
        }
    }

    fn stop(mut self) {
        // Closing stdin also asks Node to shut down if the desktop process is interrupted.
        drop(self.child.stdin.take());
        let began = Instant::now();
        while began.elapsed() < SHUTDOWN_GRACE {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => thread::sleep(CHECK_INTERVAL),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn parse_readiness(line: &str) -> Option<SocketAddrV4> {
    let port: u16 = line
        .strip_prefix(READINESS_PREFIX)?
        .strip_suffix("/\n")?
        .parse()
        .ok()?;
    (port != 0).then(|| SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_accepts_only_a_loopback_address_and_nonzero_port() {
        assert_eq!(
            parse_readiness("Praxis at http://127.0.0.1:1234/\n"),
            Some(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 1234))
        );
        for invalid in [
            "Praxis at http://0.0.0.0:1234/\n",
            "Praxis at http://127.0.0.1:0/\n",
            "Praxis at http://127.0.0.1:65536/\n",
            "Praxis at http://127.0.0.1:1234/",
            "Praxis at http://127.0.0.1:1234/\nsecret",
        ] {
            assert_eq!(parse_readiness(invalid), None);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_owned_child_without_a_readiness_reply_times_out() {
        let child = Command::new("sh")
            .args(["-c", "read -r reply"])
            .stdin(Stdio::piped())
            .spawn()
            .expect("start fixture child");
        let (_send, receive) = mpsc::channel();
        let mut owned = OwnedHost {
            child,
            started: Instant::now() - STARTUP_LIMIT,
            readiness: Some(receive),
        };
        let result = owned.check();
        owned.stop();
        assert_eq!(result, Err("The local Praxis host took too long to start."));
    }
}
