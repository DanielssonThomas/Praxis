use crate::models::activity::{ActivityCard, DecideActivityRequest, InspectActivityRequest};
use crate::models::workflow_error::WorkflowError;
use crate::services::{activity, host_http::HostClient};
use crate::state::{host::ManagedHost, operator::OperatorSessions};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn unlock_activity(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
    token: String,
) -> Result<Vec<ActivityCard>, WorkflowError> {
    activity::unlock(&client, &host, &sessions, &token).await
}

#[tauri::command]
#[specta::specta]
pub(crate) fn lock_activity(sessions: State<'_, OperatorSessions>) {
    sessions.clear(activity::SCOPE);
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn read_activity(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
) -> Result<Vec<ActivityCard>, WorkflowError> {
    activity::read(&client, &host, sessions.get(activity::SCOPE)).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn inspect_activity(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
    request: InspectActivityRequest,
) -> Result<ActivityCard, WorkflowError> {
    activity::submit(&client, &host, &sessions, "/api/activity/inspect", &request).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn decide_activity(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
    request: DecideActivityRequest,
) -> Result<ActivityCard, WorkflowError> {
    activity::submit(
        &client,
        &host,
        &sessions,
        "/api/activity/decision",
        &request,
    )
    .await
}
