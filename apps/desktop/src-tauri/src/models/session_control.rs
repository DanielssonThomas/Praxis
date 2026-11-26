use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Type)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum SessionControlRequest {
    Takeover { session_id: String },
    Guide { session_id: String, text: String },
    Return { session_id: String },
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionControl {
    mode: SessionControlMode,
    can_takeover: bool,
    can_guide: bool,
    can_return: bool,
    guidance: GuidanceReceipt,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionControlMode {
    ReadOnly,
    Manual,
    AutomatedWrite,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GuidanceReceipt {
    None,
    Pending,
    Uncertain,
    Delivered,
    Recorded,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_operator_command_keeps_exact_session_and_guidance_on_the_wire() {
        let input =
            json!({"operation":"guide","sessionId":"session_fixture","text":"Check the fixture."});
        let request = serde_json::from_value::<SessionControlRequest>(input.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), input);
        assert!(
            serde_json::from_value::<SessionControlRequest>(json!({
                "operation":"guide", "sessionId":"session_fixture", "text":"Check the fixture.", "approvalId":"foreign"
            })).is_err()
        );
    }
}
