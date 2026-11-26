use crate::models::presentation::SessionSnapshot;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityRecord {
    request_id: String,
    actor_id: String,
    action: ActivityAction,
    #[serde(flatten)]
    phase: ActivityPhase,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActivityCard {
    request_id: String,
    actor_id: String,
    action: ActivityAction,
    phase: ActivityPhase,
}

impl From<ActivityRecord> for ActivityCard {
    fn from(record: ActivityRecord) -> Self {
        Self {
            request_id: record.request_id,
            actor_id: record.actor_id,
            action: record.action,
            phase: record.phase,
        }
    }
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct ActivityAction {
    kind: String,
    target: ActivityTarget,
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct ActivityTarget {
    kind: ActivityTargetKind,
    id: String,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ActivityTargetKind {
    Session,
    Task,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ActivityPhase {
    Processing,
    Attention {
        approval: ApprovalReference,
        expires_at: String,
    },
    Resolved {
        native: SessionSnapshot,
    },
    Denied,
    Expired {
        reason: String,
    },
    Invalidated {
        reason: String,
    },
    Refused {
        reason: String,
    },
    Uncertain {
        reason: String,
    },
    Escalated {
        reason: String,
    },
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct ApprovalReference {
    id: String,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InspectActivityRequest {
    request_id: String,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DecideActivityRequest {
    request_id: String,
    approval_id: String,
    decision: OperatorDecision,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperatorDecision {
    Approve,
    Deny,
}
