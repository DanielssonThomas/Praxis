use crate::models::ipc_error::IpcError;
use serde::Serialize;
use specta::Type;

#[derive(Clone, Copy, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum WorkflowErrorCode {
    Locked,
    Denied,
    SetupRequired,
    InvalidInput,
    Busy,
    Unavailable,
    Interrupted,
}

#[derive(Serialize, Type)]
pub(crate) struct WorkflowError {
    code: WorkflowErrorCode,
    message: &'static str,
}

impl WorkflowError {
    pub(crate) fn new(code: WorkflowErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }

    pub(crate) fn is_denied(&self) -> bool {
        matches!(self.code, WorkflowErrorCode::Denied)
    }
}

impl From<IpcError> for WorkflowError {
    fn from(error: IpcError) -> Self {
        Self::new(WorkflowErrorCode::Unavailable, error.message)
    }
}
