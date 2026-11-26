use crate::models::session_control::{SessionControl, SessionControlRequest};
use crate::models::workflow_error::{WorkflowError, WorkflowErrorCode};
use crate::services::host_http::{HostClient, read_json, transport_error};
use crate::services::overview;
use crate::state::{host::ManagedHost, operator::OperatorSessions};
use reqwest::{Method, StatusCode, header::AUTHORIZATION};
use serde::Deserialize;
use std::time::Duration;

const PATH: &str = "/api/overview/control";

#[derive(Deserialize)]
struct ReconciliationError {
    error: String,
}

pub(crate) async fn operate(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    input: &SessionControlRequest,
) -> Result<SessionControl, WorkflowError> {
    let credential = sessions.get(overview::SCOPE).ok_or_else(|| {
        WorkflowError::new(
            WorkflowErrorCode::Locked,
            "Open Overview before using session controls.",
        )
    })?;
    let response = client
        .request(host, Method::POST, PATH)?
        .header(AUTHORIZATION, credential)
        .timeout(Duration::from_secs(30))
        .json(input)
        .send()
        .await
        .map_err(transport_error)?;
    let error = match response.status() {
        StatusCode::OK => return Ok(read_json(response, 4096).await?),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => WorkflowError::new(
            WorkflowErrorCode::Denied,
            "The operator or this session's manual control is unavailable.",
        ),
        StatusCode::BAD_REQUEST | StatusCode::NOT_FOUND => WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
            "Choose an available session and valid guidance.",
        ),
        StatusCode::CONFLICT => {
            let detail = read_json::<ReconciliationError>(response, 4096).await;
            let message = match detail.as_ref().map(|response| response.error.as_str()) {
                Ok(
                    "Hermes has yet to expose this guidance in the native transcript. Manual control remains active.",
                ) => {
                    "Hermes has yet to expose this guidance in the native transcript. Manual control remains active."
                }
                Ok(
                    "The native guidance outcome is uncertain. Confirm it in Hermes before sending again or returning control.",
                ) => {
                    "The native guidance outcome is uncertain. Confirm it in Hermes before sending again or returning control."
                }
                _ => "The current native session cannot accept this control request.",
            };
            WorkflowError::new(WorkflowErrorCode::Conflict, message)
        }
        _ => WorkflowError::new(
            WorkflowErrorCode::Unavailable,
            "The local session controls are unavailable.",
        ),
    };
    Err(error)
}
