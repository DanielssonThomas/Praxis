use crate::models::manager::{ManagerFrame, ManagerMessage, ManagerTurnRequest};
use crate::models::workflow_error::{WorkflowError, WorkflowErrorCode};
use crate::services::host_http::{HostClient, read_json, transport_error};
use crate::state::host::ManagedHost;
use crate::state::manager_stream::ManagerStreams;
use crate::state::operator::OperatorSessions;
use reqwest::{Method, Response, StatusCode, header::AUTHORIZATION};
use std::time::Duration;

pub(crate) const SCOPE: &str = "manager";
const PATH: &str = "/api/manager/turn";
const MAX_FRAME: usize = 128 * 1024;

pub(crate) async fn unlock(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    token: &str,
) -> Result<Vec<ManagerMessage>, WorkflowError> {
    let authorization = OperatorSessions::authorization(token).ok_or_else(denied)?;
    let response = client
        .request(host, Method::GET, PATH)?
        .header(AUTHORIZATION, authorization.clone())
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(transport_error)?;
    let messages = read_json(accepted(response)?, 1024 * 1024).await?;
    sessions.remember(SCOPE, authorization);
    Ok(messages)
}

pub(crate) async fn stream(
    client: &HostClient,
    host: &ManagedHost,
    sessions: &OperatorSessions,
    streams: &ManagerStreams,
    request: ManagerTurnRequest,
    publish: impl FnMut(ManagerFrame) -> bool,
) -> Result<(), WorkflowError> {
    if !request.is_valid() {
        return Err(WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
            "Supply a valid manager turn.",
        ));
    }
    let authorization = sessions.get(SCOPE).ok_or_else(|| {
        WorkflowError::new(WorkflowErrorCode::Locked, "Open Manager before sending.")
    })?;
    let active = streams
        .claim()
        .ok_or_else(|| WorkflowError::new(WorkflowErrorCode::Busy, "Wait for the current turn."))?;
    let request = client
        .request(host, Method::POST, PATH)?
        .header(AUTHORIZATION, authorization)
        .json(&request);
    tokio::select! {
        _ = active.disconnected() => Ok(()),
        result = async {
            let response = request.send().await.map_err(transport_error)?;
            if matches!(response.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                sessions.clear(SCOPE);
            }
            stream_frames(accepted(response)?, publish).await
        } => result
    }
}

async fn stream_frames(
    mut response: Response,
    mut publish: impl FnMut(ManagerFrame) -> bool,
) -> Result<(), WorkflowError> {
    let mut pending = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
        for line in chunk.split_inclusive(|byte| *byte == b'\n') {
            if line.len() > MAX_FRAME.saturating_sub(pending.len()) {
                return Err(interrupted());
            }
            pending.extend_from_slice(line);
            if pending.ends_with(b"\n") {
                let frame: ManagerFrame =
                    serde_json::from_slice(&pending).map_err(|_| interrupted())?;
                pending.clear();
                if matches!(frame, ManagerFrame::Error) {
                    return Err(interrupted());
                }
                let settled = frame.settled();
                if !publish(frame) || settled {
                    return Ok(());
                }
            }
        }
    }
    Err(interrupted())
}

fn accepted(response: Response) -> Result<Response, WorkflowError> {
    match response.status() {
        StatusCode::OK => Ok(response),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(denied()),
        StatusCode::SERVICE_UNAVAILABLE => Err(WorkflowError::new(
            WorkflowErrorCode::SetupRequired,
            "Configure the local operator and named Hermes manager.",
        )),
        StatusCode::BAD_REQUEST | StatusCode::CONFLICT => Err(WorkflowError::new(
            WorkflowErrorCode::InvalidInput,
            "The manager could not accept this turn.",
        )),
        _ => Err(interrupted()),
    }
}

fn denied() -> WorkflowError {
    WorkflowError::new(WorkflowErrorCode::Denied, "The operator token was refused.")
}

fn interrupted() -> WorkflowError {
    WorkflowError::new(
        WorkflowErrorCode::Interrupted,
        "The manager stream was interrupted. Reconnect to continue.",
    )
}
