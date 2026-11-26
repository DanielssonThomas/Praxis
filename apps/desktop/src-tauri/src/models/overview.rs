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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_overview_bridge_preserves_the_codex_identity_and_control_reason() {
        let mut incoming = json!({
            "task": {"id": "task_fixture", "title": "Fixture task"},
            "session": {"id": "session_fixture", "taskId": "task_fixture"},
            "ticket": "task_fixture",
            "highlighted": false,
            "runtime": {"availability": "unavailable", "reason": "Waiting for native output."},
            "control": {
                "mode": "read_only", "canTakeover": false, "canGuide": false, "canReturn": false,
                "guidance": "none", "unavailableReason": "Manual control is unavailable for Codex."
            },
            "worker": {"runtime": "codex", "runId": "native_fixture_run"}
        });
        let pane = serde_json::from_value::<OverviewPane>(incoming.clone()).unwrap();
        let outgoing = serde_json::to_value(pane).unwrap();
        assert_eq!(outgoing["worker"], incoming["worker"]);
        assert_eq!(outgoing["control"], incoming["control"]);

        incoming.as_object_mut().unwrap().remove("worker");
        incoming["control"].as_object_mut().unwrap().remove("unavailableReason");
        let pane = serde_json::from_value::<OverviewPane>(incoming).unwrap();
        let outgoing = serde_json::to_value(pane).unwrap();
        assert!(outgoing.get("worker").is_none());
        assert!(outgoing["control"].get("unavailableReason").is_none());
    }
}
