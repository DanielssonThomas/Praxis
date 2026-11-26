use crate::models::presentation::{
    SessionSnapshot, SessionStatus, SessionSummary, TaskSummary, UsageMeasurement,
};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManagerTurnRequest {
    turn_id: String,
    prompt: String,
}

impl ManagerTurnRequest {
    pub(crate) fn is_valid(&self) -> bool {
        let mut id = self.turn_id.bytes();
        id.next().is_some_and(|byte| byte.is_ascii_alphanumeric())
            && self.turn_id.len() <= 128
            && id.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            && !self.prompt.trim().is_empty()
            && self.prompt.len() <= 4_096
    }
}

#[derive(Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ManagerFrame {
    Snapshot {
        snapshot: SessionSnapshot,
        usage: UsageMeasurement,
        resources: Option<Vec<ManagerResource>>,
    },
    Error,
}

impl ManagerFrame {
    pub(crate) fn settled(&self) -> bool {
        matches!(self, Self::Snapshot { snapshot, .. } if snapshot.status.is_settled())
    }
}

#[derive(Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ManagerResource {
    Task {
        task: TaskSummary,
    },
    Session {
        session: SessionSummary,
        status: Option<SessionStatus>,
    },
    Unavailable {
        resource: ResourceKind,
    },
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ResourceKind {
    Task,
    Session,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ManagerRole {
    User,
    Assistant,
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct ManagerMessage {
    role: ManagerRole,
    text: String,
}
