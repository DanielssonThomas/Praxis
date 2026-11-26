use crate::models::reports::{ReportHistoryConfirmation, ReportPreferences, ReportResult};
use crate::models::workflow_error::{WorkflowError, WorkflowErrorCode};
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
) -> Result<ReportResult, WorkflowError> {
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
) -> Result<ReportResult, WorkflowError> {
    let authorization = sessions.get(SCOPE).ok_or_else(|| {
        WorkflowError::new(
            WorkflowErrorCode::Locked,
            "Enter the operator credential to open Reports.",
        )
    })?;
    let result = request(client, host, days, authorization, operation).await;
    if result.as_ref().is_err_and(|error| error.is_denied()) {
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
) -> Result<ReportResult, WorkflowError> {
    if !matches!(days, 7 | 30 | 90) {
        return Err(WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
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
        StatusCode::OK => Ok(read_json(response, RESPONSE_LIMIT).await?),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(rejected_credential()),
        StatusCode::NOT_FOUND | StatusCode::SERVICE_UNAVAILABLE => Err(WorkflowError::new(
            WorkflowErrorCode::SetupRequired,
            "Local reports are unavailable. Check the operational store and operator setup.",
        )),
        StatusCode::BAD_REQUEST => Err(WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
            "Check the report preferences and history confirmation.",
        )),
        StatusCode::CONFLICT => Err(WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
            "Enable clearing history in report preferences.",
        )),
        _ => Err(WorkflowError::new(
            WorkflowErrorCode::Unavailable,
            "The local reports request was refused.",
        )),
    }
}

fn rejected_credential() -> WorkflowError {
    WorkflowError::new(
        WorkflowErrorCode::Denied,
        "The operator credential was refused.",
    )
}
