use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum IpcErrorCode {
    HostUnavailable,
    HostTimedOut,
    InvalidHostResponse,
    HostRetryFailed,
    FeatureUnavailable,
    InvalidInput,
    OperatorCredentialRequired,
    OperatorCredentialRejected,
    OperationRejected,
}

#[derive(Debug, PartialEq, Eq, Serialize, Type)]
pub(crate) struct IpcError {
    pub(crate) code: IpcErrorCode,
    pub(crate) message: &'static str,
}

impl IpcError {
    pub(crate) fn new(code: IpcErrorCode, message: &'static str) -> Self {
        Self { code, message }
    }
}
