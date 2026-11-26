use crate::models::ipc_error::{IpcError, IpcErrorCode};
use crate::models::reports::{ReportHistoryConfirmation, ReportPreferences, ReportResult};
use crate::services::host_http::{HostClient, read_json, transport_error};
use crate::state::host::ManagedHost;
use crate::state::operator::OperatorSessions;
use reqwest::header::{AUTHORIZATION, HeaderValue};
use reqwest::{Method, StatusCode};
use std::time::Duration;

const SCOPE: &str = "reports";
const TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_LIMIT: usize = 64 * 1024;

pub(crate) enum ReportOperation {
    Read,
    Preferences(ReportPreferences),
    Clear(ReportHistoryConfirmation),
}

pub(crate) async fn unlock(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    credential: &str,
    days: u8,
) -> Result<ReportResult, IpcError> {
    let authorization =
        OperatorSessions::authorization(credential).ok_or_else(rejected_credential)?;
    let result = request(
        client,
        host,
        days,
        authorization.clone(),
        ReportOperation::Read,
    )
    .await?;
    sessions.remember(SCOPE, authorization);
    Ok(result)
}

pub(crate) async fn execute(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    days: u8,
    operation: ReportOperation,
) -> Result<ReportResult, IpcError> {
    let authorization = sessions.get(SCOPE).ok_or_else(|| {
        IpcError::new(
            IpcErrorCode::OperatorCredentialRequired,
            "Enter the operator credential to open Reports.",
        )
    })?;
    let result = request(client, host, days, authorization, operation).await;
    if result
        .as_ref()
        .is_err_and(|error| error.code == IpcErrorCode::OperatorCredentialRejected)
    {
        lock(sessions);
    }
    result
}

pub(crate) fn lock(sessions: &OperatorSessions) {
    sessions.clear(SCOPE);
}

async fn request(
    client: &HostClient,
    host: &ManagedHost,
    days: u8,
    authorization: HeaderValue,
    operation: ReportOperation,
) -> Result<ReportResult, IpcError> {
    if !matches!(days, 7 | 30 | 90) {
        return Err(IpcError::new(
            IpcErrorCode::InvalidInput,
            "Choose a 7, 30 or 90 day range.",
        ));
    }
    let (method, path) = match &operation {
        ReportOperation::Read => (Method::GET, "/api/reports"),
        ReportOperation::Preferences(_) => (Method::POST, "/api/reports/preferences"),
        ReportOperation::Clear(_) => (Method::POST, "/api/reports/clear"),
    };
    let builder = client
        .request(host, method, path)?
        .query(&[("days", days)])
        .header(AUTHORIZATION, authorization)
        .timeout(TIMEOUT);
    let builder = match operation {
        ReportOperation::Read => builder,
        ReportOperation::Preferences(options) => builder.json(&options),
        ReportOperation::Clear(confirmation) => builder.json(&confirmation),
    };
    let response = builder.send().await.map_err(transport_error)?;
    match response.status() {
        StatusCode::OK => read_json(response, RESPONSE_LIMIT).await,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(rejected_credential()),
        StatusCode::NOT_FOUND | StatusCode::SERVICE_UNAVAILABLE => Err(IpcError::new(
            IpcErrorCode::FeatureUnavailable,
            "Local reports are unavailable. Check the operational store and operator setup.",
        )),
        StatusCode::BAD_REQUEST => Err(IpcError::new(
            IpcErrorCode::InvalidInput,
            "Check the report preferences and history confirmation.",
        )),
        StatusCode::CONFLICT => Err(IpcError::new(
            IpcErrorCode::OperationRejected,
            "Enable clearing history in report preferences.",
        )),
        _ => Err(IpcError::new(
            IpcErrorCode::OperationRejected,
            "The local reports request was refused.",
        )),
    }
}

fn rejected_credential() -> IpcError {
    IpcError::new(
        IpcErrorCode::OperatorCredentialRejected,
        "The operator credential was refused.",
    )
}
