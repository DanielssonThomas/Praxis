use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReportMetric {
    PrsOpened,
    PrsMerged,
    TicketsCompleted,
    TaskMinutes,
    Tokens,
    CostUsd,
    Interventions,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportPreferences {
    pub(crate) collection_enabled: bool,
    pub(crate) retention_days: u8,
    pub(crate) visible_metrics: Vec<ReportMetric>,
    pub(crate) allow_export: bool,
    pub(crate) allow_clear_history: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cleared_before: Option<String>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReportMetricValues {
    pub(crate) prs_opened: Option<f64>,
    pub(crate) prs_merged: Option<f64>,
    pub(crate) tickets_completed: Option<f64>,
    pub(crate) task_minutes: Option<f64>,
    pub(crate) tokens: Option<f64>,
    pub(crate) cost_usd: Option<f64>,
    pub(crate) interventions: Option<f64>,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReportBucket {
    pub(crate) day: String,
    pub(crate) metrics: ReportMetricValues,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReportResult {
    pub(crate) days: u8,
    pub(crate) buckets: Vec<ReportBucket>,
    pub(crate) preferences: ReportPreferences,
}

#[derive(Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReportUnlock {
    pub(crate) credential: String,
    pub(crate) days: u8,
}

#[derive(Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReportPreferenceUpdate {
    pub(crate) days: u8,
    pub(crate) preferences: ReportPreferences,
}

#[derive(Deserialize, Serialize, Type)]
#[serde(deny_unknown_fields)]
pub(crate) struct ReportHistoryConfirmation {
    pub(crate) confirmed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    #[test]
    fn report_measurements_keep_null_gaps_and_measured_zero() {
        let input = json!({
            "prsOpened": null, "prsMerged": null, "ticketsCompleted": null,
            "taskMinutes": null, "tokens": null, "costUsd": 0, "interventions": 0
        });
        let metrics: ReportMetricValues = serde_json::from_value(input).unwrap();
        let wire = to_value(metrics).unwrap();
        assert!(wire["tokens"].is_null());
        assert_eq!(wire["costUsd"].as_f64(), Some(0.0));
        assert_eq!(to_value(ReportMetric::CostUsd).unwrap(), json!("costUsd"));
    }
}
