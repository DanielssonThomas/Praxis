use crate::models::activity::{ActivityCard, ActivityRecord};
use crate::models::workflow_error::{WorkflowError, WorkflowErrorCode};
use crate::services::host_http::{HostClient, read_json, transport_error};
use crate::state::{host::ManagedHost, operator::OperatorSessions};
use reqwest::{
    Method, Response, StatusCode,
    header::{AUTHORIZATION, HeaderValue},
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub(crate) const SCOPE: &str = "activity";
const PATH: &str = "/api/activity";
const LIMIT_BYTES: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Deserialize)]
struct ApprovalErrorCode {
    code: String,
}

pub(crate) async fn unlock(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    token: &str,
) -> Result<Vec<ActivityCard>, WorkflowError> {
    let authorization = OperatorSessions::authorization(token).ok_or_else(denied)?;
    let cards = read(client, host, Some(authorization.clone())).await?;
    sessions.remember(SCOPE, authorization);
    Ok(cards)
}

pub(crate) async fn read(
    client: &HostClient,
    host: &ManagedHost,
    authorization: Option<HeaderValue>,
) -> Result<Vec<ActivityCard>, WorkflowError> {
    let mut request = client.request(host, Method::GET, PATH)?.timeout(TIMEOUT);
    if let Some(value) = authorization {
        request = request.header(AUTHORIZATION, value);
    }
    let response = request.send().await.map_err(transport_error)?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(WorkflowError::new(
            WorkflowErrorCode::SetupRequired,
            "Configure the local authority and Hermes to open Activity.",
        ));
    }
    let items: Vec<ActivityRecord> = read_json(accepted(response).await?, LIMIT_BYTES).await?;
    Ok(items.into_iter().map(ActivityCard::from).collect())
}

pub(crate) async fn submit<T: Serialize>(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    path: &'static str,
    input: &T,
) -> Result<ActivityCard, WorkflowError> {
    let credential = sessions.get(SCOPE).ok_or_else(denied)?;
    let response = client
        .request(host, Method::POST, path)?
        .header(AUTHORIZATION, credential)
        .timeout(TIMEOUT)
        .json(input)
        .send()
        .await
        .map_err(transport_error)?;
    let item: ActivityRecord = read_json(accepted(response).await?, LIMIT_BYTES).await?;
    Ok(item.into())
}

async fn accepted(response: Response) -> Result<Response, WorkflowError> {
    let failure = match response.status() {
        StatusCode::OK => return Ok(response),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => denied(),
        StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND => WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
            "The requested activity or approval is unavailable.",
        ),
        StatusCode::CONFLICT => {
            let cause = read_json::<ApprovalErrorCode>(response, 4096).await;
            let message = match cause.as_ref().map(|response| response.code.as_str()) {
                Ok("control_busy") => {
                    "Session control holds this action. Wait for control to return before approving it."
                }
                Ok("expired") => "This approval expired. A new action request is required.",
                Ok("invalidated") => {
                    "The actor grant or native assignment changed. A new request is required."
                }
                Ok("already_decided") => "This activity already has a decision.",
                _ => "This approval no longer matches the reviewed action.",
            };
            WorkflowError::new(WorkflowErrorCode::Conflict, message)
        }
        _ => WorkflowError::new(
            WorkflowErrorCode::Unavailable,
            "The local activity service is unavailable.",
        ),
    };
    Err(failure)
}

fn denied() -> WorkflowError {
    WorkflowError::new(
        WorkflowErrorCode::Denied,
        "An operator credential is required.",
    )
}
