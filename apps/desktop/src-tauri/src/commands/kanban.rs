use crate::models::kanban::{KanbanBoard, KanbanError, KanbanIssueTarget, KanbanLinkReceipt};
use crate::services::host_http::HostClient;
use crate::services::kanban::{KanbanService, open_issue_in_browser};
use crate::state::{host::ManagedHost, operator::OperatorSessions};
use tauri::State;

const SCOPE: &str = "kanban";

#[tauri::command]
#[specta::specta]
pub(crate) async fn kanban_list(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
) -> Result<KanbanBoard, KanbanError> {
    let result = KanbanService::new(&client, &host)
        .list(sessions.get(SCOPE))
        .await;
    if matches!(result, Err(KanbanError::OperatorRequired)) {
        sessions.clear(SCOPE);
    }
    result
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn kanban_unlock(
    credential: String,
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
) -> Result<KanbanBoard, KanbanError> {
    let authorization =
        OperatorSessions::authorization(&credential).ok_or(KanbanError::OperatorRequired)?;
    drop(credential);
    let board = KanbanService::new(&client, &host)
        .list(Some(authorization.clone()))
        .await?;
    sessions.remember(SCOPE, authorization);
    Ok(board)
}

#[tauri::command]
#[specta::specta]
pub(crate) fn kanban_lock(sessions: State<'_, OperatorSessions>) {
    sessions.clear(SCOPE);
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn kanban_link_issue(
    target: KanbanIssueTarget,
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
) -> Result<KanbanLinkReceipt, KanbanError> {
    KanbanService::new(&client, &host)
        .link(sessions.get(SCOPE), target)
        .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn kanban_open_issue(
    target: KanbanIssueTarget,
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
) -> Result<(), KanbanError> {
    let url = KanbanService::new(&client, &host)
        .verified_url(sessions.get(SCOPE), &target)
        .await?;
    tauri::async_runtime::spawn_blocking(move || open_issue_in_browser(url))
        .await
        .map_err(|_| KanbanError::BrowserUnavailable)?
}
