use crate::models::ipc_error::IpcError;
use crate::models::settings::PortableSettings;
use crate::services::host_http::HostClient;
use crate::services::settings;
use crate::state::host::ManagedHost;
use tauri::State;

#[tauri::command]
#[specta::specta]
pub(crate) async fn read_settings(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
) -> Result<PortableSettings, IpcError> {
    settings::read(&client, &host).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn save_settings(
    host: State<'_, ManagedHost>,
    client: State<'_, HostClient>,
    settings: PortableSettings,
) -> Result<PortableSettings, IpcError> {
    settings::save(&client, &host, settings).await
}
