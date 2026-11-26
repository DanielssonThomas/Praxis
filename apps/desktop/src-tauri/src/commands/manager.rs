use crate::models::manager::{ManagerFrame, ManagerMessage, ManagerTurnRequest};
use crate::models::workflow_error::WorkflowError;
use crate::services::{host_http::HostClient, manager};
use crate::state::{host::ManagedHost, manager_stream::ManagerStreams, operator::OperatorSessions};
use tauri::{State, ipc::Channel};

#[tauri::command]
#[specta::specta]
pub(crate) async fn unlock_manager(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
    token: String,
) -> Result<Vec<ManagerMessage>, WorkflowError> {
    manager::unlock(&client, &host, &sessions, &token).await
}

#[tauri::command]
#[specta::specta]
pub(crate) fn lock_manager(
    sessions: State<'_, OperatorSessions>,
    streams: State<'_, ManagerStreams>,
) {
    sessions.clear(manager::SCOPE);
    streams.disconnect();
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn manager_turn(
    client: State<'_, HostClient>,
    host: State<'_, ManagedHost>,
    sessions: State<'_, OperatorSessions>,
    streams: State<'_, ManagerStreams>,
    request: ManagerTurnRequest,
    output: Channel<ManagerFrame>,
) -> Result<(), WorkflowError> {
    manager::stream(&client, &host, &sessions, &streams, request, |frame| {
        output.send(frame).is_ok()
    })
    .await
}
