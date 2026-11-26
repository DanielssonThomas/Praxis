use crate::state::host::ManagedHost;
use tauri::State;

#[tauri::command]
pub(crate) fn host_launch_status(host: State<'_, ManagedHost>) -> Option<&'static str> {
    host.launch_message()
}

#[tauri::command]
pub(crate) fn retry_host(host: State<'_, ManagedHost>) -> Result<(), &'static str> {
    host.retry()
}
