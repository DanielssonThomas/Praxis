use crate::models::reports::{
    ReportHistoryConfirmation, ReportPreferenceUpdate, ReportResult, ReportUnlock,
};
use crate::models::workflow_error::WorkflowError;
use crate::services::host_http::HostClient;
use crate::services::reports::{self, ReportOperation};
use crate::state::host::ManagedHost;
use crate::state::operator::OperatorSessions;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn unlock_reports(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
    request: ReportUnlock,
) -> Result<ReportResult, WorkflowError> {
    reports::unlock(&client, &host, &sessions, &request.credential, request.days).await
}

#[tauri::command]
#[specta::specta]
pub(crate) fn lock_reports(sessions: State<'_, OperatorSessions>) {
    reports::lock(&sessions);
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn read_reports(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
    days: u8,
) -> Result<ReportResult, WorkflowError> {
    reports::execute(&client, &host, &sessions, days, ReportOperation::Read).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_report_preferences(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
    request: ReportPreferenceUpdate,
) -> Result<ReportResult, WorkflowError> {
    reports::execute(
        &client,
        &host,
        &sessions,
        request.days,
        ReportOperation::Preferences(request.preferences),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn clear_report_history(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    sessions: State<'_, OperatorSessions>,
    days: u8,
    confirmation: ReportHistoryConfirmation,
) -> Result<ReportResult, WorkflowError> {
    reports::execute(
        &client,
        &host,
        &sessions,
        days,
        ReportOperation::Clear(confirmation),
    )
    .await
}
