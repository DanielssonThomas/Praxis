use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum HostStage {
    Starting,
    Ready,
}

#[derive(Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostStatus {
    stage: HostStage,
    node_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_after_ms: Option<u16>,
}

impl HostStatus {
    pub(crate) fn starting() -> Self {
        Self {
            stage: HostStage::Starting,
            node_version: None,
            retry_after_ms: Some(250),
        }
    }

    pub(crate) fn ready(node_version: String) -> Self {
        Self {
            stage: HostStage::Ready,
            node_version: Some(node_version),
            retry_after_ms: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ipc_error::{IpcError, IpcErrorCode};
    use serde_json::{json, to_value};

    #[test]
    fn the_wire_shape_preserves_stage_casing_node_nullability_and_optional_retry() {
        assert_eq!(
            to_value(HostStatus::starting()).unwrap(),
            json!({"stage": "starting", "nodeVersion": null, "retryAfterMs": 250})
        );
        assert_eq!(
            to_value(HostStatus::ready("24.22.3".into())).unwrap(),
            json!({"stage": "ready", "nodeVersion": "24.22.3"})
        );
    }

    #[test]
    fn retry_milliseconds_fit_in_a_javascript_safe_integer() {
        let value = HostStatus {
            retry_after_ms: Some(u16::MAX),
            ..HostStatus::starting()
        };
        assert_eq!(to_value(value).unwrap()["retryAfterMs"], json!(65_535));
    }

    #[test]
    fn structured_error_codes_use_the_documented_wire_spelling() {
        let error = IpcError::new(
            IpcErrorCode::HostUnavailable,
            "The local Praxis host stopped.",
        );
        assert_eq!(
            to_value(error).unwrap(),
            json!({"code": "host_unavailable", "message": "The local Praxis host stopped."})
        );
    }
}
