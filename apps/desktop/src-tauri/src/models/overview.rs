use crate::models::presentation::{SessionSnapshot, SessionSummary, TaskSummary, UsageMeasurement};
use crate::models::session_control::SessionControl;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct OverviewPageRequest {
    pub(crate) page: u32,
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct OverviewProjection {
    panes: Vec<OverviewPane>,
    association: OverviewAssociation,
    page: OverviewPage,
}

#[derive(Deserialize, Serialize, Type)]
pub(crate) struct OverviewPage {
    number: u32,
    count: u32,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverviewPane {
    task: TaskSummary,
    session: SessionSummary,
    ticket: String,
    highlighted: bool,
    runtime: OverviewRuntime,
    control: SessionControl,
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
