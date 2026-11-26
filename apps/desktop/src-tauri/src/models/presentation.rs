use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SessionStatus {
    Queued,
    Running,
    WaitingForApproval,
    Stopping,
    Stopped,
    Completed,
    Failed,
    Interrupted,
    Unknown,
}

impl SessionStatus {
    pub(crate) fn is_settled(self) -> bool {
        matches!(
            self,
            Self::Stopped | Self::Completed | Self::Failed | Self::Interrupted | Self::Unknown
        )
    }
}

#[derive(Deserialize, Serialize, Type)]
#[serde(tag = "availability", rename_all = "snake_case")]
pub(crate) enum SessionOutput {
    Available { text: String, truncated: bool },
    Unavailable { reason: String },
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct SessionSnapshot {
    pub(crate) status: SessionStatus,
    pub(crate) output: SessionOutput,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSummary {
    id: String,
    title: String,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionSummary {
    id: String,
    task_id: String,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(
    tag = "metering",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum UsageMeasurement {
    Unknown {
        reason: String,
    },
    Reported {
        // The Node contract validates these counts as safe JS integers before rendering.
        input_tokens: Option<f64>,
        output_tokens: Option<f64>,
        cost: Option<UsageCost>,
    },
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct UsageCost {
    amount: f64,
    currency: String,
}
