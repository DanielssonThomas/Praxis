use crate::models::ipc_error::{IpcError, IpcErrorCode};
use crate::models::settings::PortableSettings;
use crate::services::host_http::{HostClient, read_json, transport_error};
use crate::state::host::ManagedHost;
use reqwest::{Method, StatusCode};
use std::time::Duration;

const SETTINGS_PATH: &str = "/api/settings";
const TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_LIMIT: usize = 16 * 1024;

pub(crate) async fn read(
    client: &HostClient,
    host: &ManagedHost,
) -> Result<PortableSettings, IpcError> {
    request(client, host, None).await
}

pub(crate) async fn save(
    client: &HostClient,
    host: &ManagedHost,
    settings: PortableSettings,
) -> Result<PortableSettings, IpcError> {
    request(client, host, Some(settings)).await
}

async fn request(
    client: &HostClient,
    host: &ManagedHost,
    settings: Option<PortableSettings>,
) -> Result<PortableSettings, IpcError> {
    let method = if settings.is_some() {
        Method::PUT
    } else {
        Method::GET
    };
    let builder = client
        .request(host, method, SETTINGS_PATH)?
        .timeout(TIMEOUT);
    let builder = match settings {
        Some(settings) => builder.json(&settings),
        None => builder,
    };
    let response = builder.send().await.map_err(transport_error)?;
    match response.status() {
        StatusCode::OK => read_json(response, RESPONSE_LIMIT).await,
        StatusCode::BAD_REQUEST => Err(IpcError::new(
            IpcErrorCode::InvalidInput,
            "Check the portable settings values. The previous settings were kept.",
        )),
        _ => Err(IpcError::new(
            IpcErrorCode::FeatureUnavailable,
            "The local settings are unavailable. Check the settings file and its permissions.",
        )),
    }
}
