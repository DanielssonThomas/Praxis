use crate::models::kanban::{KanbanBoard, KanbanError, KanbanIssueTarget, KanbanLinkReceipt};
use crate::services::host_http::{HostClient, read_json, transport_error};
use crate::state::host::ManagedHost;
use reqwest::{
    Method, RequestBuilder, StatusCode, Url,
    header::{AUTHORIZATION, HeaderValue},
};
use serde::Deserialize;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const BOARD_PATH: &str = "/api/kanban";
const LINK_PATH: &str = "/api/kanban/link";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const BOARD_LIMIT: usize = 16 * 1024 * 1024;
const LINK_LIMIT: usize = 2 * 1024;

pub(crate) struct KanbanService<'a> {
    client: &'a HostClient,
    host: &'a ManagedHost,
}

impl<'a> KanbanService<'a> {
    pub(crate) fn new(client: &'a HostClient, host: &'a ManagedHost) -> Self {
        Self { client, host }
    }

    pub(crate) async fn list(
        &self,
        authorization: Option<HeaderValue>,
    ) -> Result<KanbanBoard, KanbanError> {
        let response = self
            .request(Method::GET, BOARD_PATH, authorization)?
            .send()
            .await
            .map_err(transport_error)?;
        match response.status() {
            StatusCode::OK => Ok(read_json(response, BOARD_LIMIT).await?),
            StatusCode::UNAUTHORIZED => Err(KanbanError::OperatorRequired),
            StatusCode::FORBIDDEN => Err(KanbanError::ScopeUnavailable),
            StatusCode::NOT_FOUND => Err(KanbanError::SetupRequired),
            _ => Err(KanbanError::BoardUnavailable),
        }
    }

    pub(crate) async fn link(
        &self,
        authorization: Option<HeaderValue>,
        target: KanbanIssueTarget,
    ) -> Result<KanbanLinkReceipt, KanbanError> {
        let response = self
            .request(Method::POST, LINK_PATH, authorization)?
            .json(&target)
            .send()
            .await
            .map_err(transport_error)?;
        match response.status() {
            StatusCode::OK => Ok(read_json(response, LINK_LIMIT).await?),
            StatusCode::UNAUTHORIZED => Err(KanbanError::OperatorRequired),
            StatusCode::BAD_REQUEST => Err(KanbanError::InvalidIssue),
            StatusCode::NOT_FOUND => Err(KanbanError::IssueNotFound),
            StatusCode::FORBIDDEN => {
                // The existing host distinguishes provider and operator rejection by its typed code.
                let rejection: HostRejection = read_json(response, LINK_LIMIT).await?;
                if rejection.code.as_deref() == Some("unauthorized") {
                    Err(KanbanError::ProviderDenied)
                } else {
                    Err(KanbanError::ScopeUnavailable)
                }
            }
            _ => Err(KanbanError::BoardUnavailable),
        }
    }

    pub(crate) async fn verified_url(
        &self,
        authorization: Option<HeaderValue>,
        target: &KanbanIssueTarget,
    ) -> Result<Url, KanbanError> {
        let board = self.list(authorization).await?;
        verified_issue_url(board, target)
    }

    fn request(
        &self,
        method: Method,
        path: &'static str,
        authorization: Option<HeaderValue>,
    ) -> Result<RequestBuilder, KanbanError> {
        let request = self
            .client
            .request(self.host, method, path)?
            .timeout(REQUEST_TIMEOUT);
        Ok(match authorization {
            Some(authorization) => request.header(AUTHORIZATION, authorization),
            None => request,
        })
    }
}

#[derive(Deserialize)]
struct HostRejection {
    code: Option<String>,
}

fn verified_issue_url(board: KanbanBoard, target: &KanbanIssueTarget) -> Result<Url, KanbanError> {
    let issue = board
        .tasks
        .into_iter()
        .find(|task| task.native_id == target.native_id)
        .and_then(|task| {
            task.links.into_iter().find(|issue| {
                issue.repository == target.repository && issue.number == target.number
            })
        })
        .ok_or(KanbanError::IssueNotFound)?;

    let (owner, repository) = issue
        .repository
        .split_once('/')
        .ok_or(KanbanError::InvalidIssue)?;
    if !valid_repository(owner, repository) {
        return Err(KanbanError::InvalidIssue);
    }
    let mut url = Url::parse("https://github.com").map_err(|_| KanbanError::BrowserUnavailable)?;
    url.path_segments_mut()
        .map_err(|_| KanbanError::BrowserUnavailable)?
        .push(owner)
        .push(repository)
        .push("issues")
        .push(&issue.number.to_string());
    Ok(url)
}

fn valid_repository(owner: &str, repository: &str) -> bool {
    (1..=39).contains(&owner.len())
        && owner.as_bytes()[0].is_ascii_alphanumeric()
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && (1..=100).contains(&repository.len())
        && !matches!(repository, "." | "..")
        && repository
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn open_issue_in_browser(url: Url) -> Result<(), KanbanError> {
    // A URI handler needs desktop session details. Runtime and provider credentials belong to Praxis.
    const DESKTOP_ENV: &[&str] = &[
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "DISPLAY",
        "XAUTHORITY",
        "WAYLAND_DISPLAY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_CONFIG_DIRS",
        "XDG_DATA_HOME",
        "XDG_DATA_DIRS",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_TYPE",
    ];
    let mut opener = Command::new("gio");
    opener
        .arg("open")
        .arg(url.as_str())
        .env_clear()
        .envs(
            DESKTOP_ENV
                .iter()
                .filter_map(|key| std::env::var_os(key).map(|value| (key, value))),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = opener
        .spawn()
        .map_err(|_| KanbanError::BrowserUnavailable)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(KanbanError::BrowserUnavailable),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(KanbanError::BrowserUnavailable);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn opens_only_the_exact_issue_already_present_on_the_selected_task() {
        fn board(repository: &str) -> KanbanBoard {
            serde_json::from_value(json!({
                "tasks": [{
                    "nativeId": "t_01234567",
                    "task": { "id": "task_1", "title": "Fixture" },
                    "assignee": null, "status": "ready",
                    "links": [{ "provider": "github", "repository": repository, "number": 42 }],
                }],
                "provider": { "available": true }
            }))
            .unwrap()
        }

        let mut target: KanbanIssueTarget = serde_json::from_value(json!({
            "nativeId": "t_01234567", "repository": "fixture/project", "number": 42
        }))
        .unwrap();
        assert_eq!(
            verified_issue_url(board("fixture/project"), &target)
                .unwrap()
                .as_str(),
            "https://github.com/fixture/project/issues/42"
        );
        assert!(matches!(
            verified_issue_url(board("other/project"), &target),
            Err(KanbanError::IssueNotFound)
        ));
        target.repository = "fixture/..".into();
        assert!(matches!(
            verified_issue_url(board("fixture/.."), &target),
            Err(KanbanError::InvalidIssue)
        ));
    }
}
