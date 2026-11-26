use crate::models::overview::{OverviewPageRequest, OverviewProjection};
use crate::models::workflow_error::{WorkflowError, WorkflowErrorCode};
use crate::services::host_http::{HostClient, read_json, transport_error};
use crate::state::host::ManagedHost;
use crate::state::operator::OperatorSessions;
use reqwest::{
    Method, StatusCode,
    header::{AUTHORIZATION, HeaderValue},
};
use std::time::Duration;

pub(crate) const SCOPE: &str = "overview";
const PATH: &str = "/api/overview";

pub(crate) async fn unlock(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    token: &str,
) -> Result<OverviewProjection, WorkflowError> {
    let authorization = OperatorSessions::authorization(token).ok_or_else(denied)?;
    let overview = request(client, host, Some(authorization.clone()), None).await?;
    sessions.remember(SCOPE, authorization);
    Ok(overview)
}

pub(crate) async fn read(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    page: Option<&OverviewPageRequest>,
) -> Result<OverviewProjection, WorkflowError> {
    request(client, host, sessions.get(SCOPE), page).await
}

async fn request(
    client: &HostClient,
    host: &ManagedHost,
    authorization: Option<HeaderValue>,
    page: Option<&OverviewPageRequest>,
) -> Result<OverviewProjection, WorkflowError> {
    let mut request = client.request(host, Method::GET, PATH)?;
    if let Some(page) = page {
        request = request.query(&[("page", page.page)]);
    }
    if let Some(header) = &authorization {
        request = request.header(AUTHORIZATION, header.clone());
    }
    let response = request
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(transport_error)?;
    match response.status() {
        StatusCode::OK => Ok(read_json(response, 1024 * 1024).await?),
        StatusCode::UNAUTHORIZED if authorization.is_none() => Err(WorkflowError::new(
            WorkflowErrorCode::Locked,
            "Open Overview with the operator token.",
        )),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(denied()),
        StatusCode::BAD_REQUEST => Err(WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
            "Supply a positive whole Overview page number.",
        )),
        StatusCode::NOT_FOUND => Err(WorkflowError::new(
            WorkflowErrorCode::SetupRequired,
            "Configure Hermes and local authority to open Overview.",
        )),
        _ => Err(WorkflowError::new(
            WorkflowErrorCode::Unavailable,
            "The native worker overview is unavailable. Reconnect to retry.",
        )),
    }
}

fn denied() -> WorkflowError {
    WorkflowError::new(WorkflowErrorCode::Denied, "The operator token was refused.")
}
