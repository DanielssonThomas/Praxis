use crate::models::session_control::{SessionControl, SessionControlRequest};
use crate::models::{overview::OverviewProjection, workflow_error::WorkflowError};
use crate::services::{host_http::HostClient, overview, session_control};
use crate::state::{host::ManagedHost, operator::OperatorSessions};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn unlock_overview(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
    token: String,
) -> Result<OverviewProjection, WorkflowError> {
    overview::unlock(&client, &host, &sessions, &token).await
}

#[tauri::command]
#[specta::specta]
pub(crate) fn lock_overview(sessions: State<'_, OperatorSessions>) {
    sessions.clear(overview::SCOPE);
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn read_overview(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
) -> Result<OverviewProjection, WorkflowError> {
    overview::read(&client, &host, &sessions).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn control_session(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
    request: SessionControlRequest,
) -> Result<SessionControl, WorkflowError> {
    session_control::operate(&client, &host, &sessions, &request).await
}
