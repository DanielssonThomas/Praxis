use crate::models::presentation::{SessionSnapshot, SessionSummary, TaskSummary, UsageMeasurement};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct OverviewProjection {
    panes: Vec<OverviewPane>,
    association: OverviewAssociation,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewPane {
    task: TaskSummary,
    session: SessionSummary,
    ticket: String,
    highlighted: bool,
    runtime: OverviewRuntime,
    usage_notice: Option<String>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(tag = "availability", rename_all = "snake_case")]
pub(crate) enum OverviewRuntime {
    Available {
        snapshot: SessionSnapshot,
        usage: UsageMeasurement,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct OverviewAssociation {
    available: bool,
    reason: Option<String>,
}
