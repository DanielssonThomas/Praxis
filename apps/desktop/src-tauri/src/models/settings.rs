use crate::models::reports::ReportPreferences;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PortableSettings {
    pub(crate) schema_version: u8,
    pub(crate) policy: PolicyPreferences,
    pub(crate) manager: ManagerPreferences,
    pub(crate) worker: WorkerPreferences,
    pub(crate) budgets: BudgetPreferences,
    pub(crate) memory: MemoryPreferences,
    pub(crate) display: DisplayPreferences,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) reports: Option<ReportPreferences>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicyPreferences {
    pub(crate) axiom_enabled: bool,
    pub(crate) profiles: Vec<String>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ManagerRuntime {
    Hermes,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManagerPreferences {
    pub(crate) runtime: ManagerRuntime,
    pub(crate) profile: String,
    pub(crate) model: Option<String>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum WorkerRuntime {
    Codex,
    Claude,
    Hermes,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkerPreferences {
    pub(crate) runtime: WorkerRuntime,
    pub(crate) model: Option<String>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BudgetPreferences {
    // The existing Node contract validates that tokens are a positive JavaScript safe integer.
    pub(crate) max_task_tokens: Option<f64>,
    pub(crate) max_task_usd: Option<f64>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct MemoryPreferences {
    pub(crate) enabled: bool,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DisplayPreferences {
    pub(crate) auto_present: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    #[test]
    fn portable_settings_keep_nullable_numbers_and_omit_absent_report_preferences() {
        let settings: PortableSettings = serde_json::from_value(json!({
            "schemaVersion": 1,
            "policy": { "axiomEnabled": true, "profiles": [] },
            "manager": { "runtime": "hermes", "profile": "praxis-manager", "model": null },
            "worker": { "runtime": "codex", "model": null },
            "budgets": { "maxTaskTokens": 9_007_199_254_740_991u64, "maxTaskUsd": null },
            "memory": { "enabled": true }, "display": { "autoPresent": true }
        }))
        .unwrap();
        let output = to_value(settings).unwrap();
        assert!(output.get("reports").is_none());
        assert!(output["budgets"]["maxTaskUsd"].is_null());
        assert_eq!(
            output["budgets"]["maxTaskTokens"].as_f64(),
            Some(9_007_199_254_740_991.0)
        );
    }
}
