use crate::models::host_status::HostStatus;
use crate::models::ipc_error::{IpcError, IpcErrorCode};
use crate::services::host_http::HostClient;
use crate::state::host::ManagedHost;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn host_status(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
) -> Result<HostStatus, IpcError> {
    client.status(&host).await
}

#[tauri::command]
#[specta::specta]
pub(crate) fn retry_host(host: State<'_, ManagedHost>) -> Result<(), IpcError> {
    host.retry()
        .map_err(|message| IpcError::new(IpcErrorCode::HostRetryFailed, message))
}
