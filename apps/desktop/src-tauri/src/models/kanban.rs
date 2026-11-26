use crate::models::ipc_error::IpcError;
use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use specta::Type;
use std::fmt::{self, Display};

const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(transparent)]
pub(crate) struct IssueNumber(#[specta(type = specta_typescript::Number)] u64);

impl<'de> Deserialize<'de> for IssueNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let number = u64::deserialize(deserializer)?;
        if number == 0 || number > MAX_SAFE_JSON_INTEGER {
            return Err(D::Error::custom(
                "Expected a positive JavaScript-safe integer.",
            ));
        }
        Ok(Self(number))
    }
}

impl Display for IssueNumber {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub(crate) enum IssueProvider {
    Github,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub(crate) struct KanbanIssue {
    pub(crate) provider: IssueProvider,
    pub(crate) repository: String,
    pub(crate) number: IssueNumber,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct KanbanIssueTarget {
    pub(crate) native_id: String,
    pub(crate) repository: String,
    pub(crate) number: IssueNumber,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KanbanLinkReceipt {
    pub(crate) task_id: String,
    pub(crate) issue: KanbanIssue,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KanbanTaskIdentity {
    pub(crate) id: String,
    pub(crate) title: String,
}

#[derive(Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KanbanTask {
    pub(crate) native_id: String,
    pub(crate) task: KanbanTaskIdentity,
    pub(crate) status: String,
    pub(crate) assignee: Option<String>,
    pub(crate) links: Vec<KanbanIssue>,
}

#[derive(Debug, Deserialize, Serialize, Type)]
pub(crate) struct KanbanProvider {
    pub(crate) available: bool,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Type)]
pub(crate) struct KanbanBoard {
    pub(crate) tasks: Vec<KanbanTask>,
    pub(crate) provider: KanbanProvider,
}

#[derive(Debug, Serialize, Type)]
#[serde(tag = "kind", content = "details", rename_all = "snake_case")]
pub(crate) enum KanbanError {
    Host(IpcError),
    SetupRequired,
    OperatorRequired,
    ScopeUnavailable,
    InvalidIssue,
    IssueNotFound,
    ProviderDenied,
    BoardUnavailable,
    BrowserUnavailable,
}

impl From<IpcError> for KanbanError {
    fn from(error: IpcError) -> Self {
        Self::Host(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_str, json, to_value};

    #[test]
    fn issue_numbers_keep_the_full_exact_node_range() {
        for value in ["1", "4294967296", "9007199254740991"] {
            let number = from_str::<IssueNumber>(value).unwrap();
            assert_eq!(number.to_string(), value);
            assert_eq!(serde_json::to_string(&number).unwrap(), value);
        }
        for value in [
            "0",
            "-1",
            "5.5",
            "9007199254740992",
            "18446744073709551615",
            "\"42\"",
        ] {
            assert!(from_str::<IssueNumber>(value).is_err());
        }
    }

    #[test]
    fn board_projection_reads_the_existing_node_shape_and_exports_nulls() {
        let board: KanbanBoard = serde_json::from_value(json!({
            "tasks": [{
                "nativeId": "t_01234567", "task": { "schemaVersion": 1, "id": "task_1", "title": "Task" },
                "status": "ready", "assignee": null,
                "links": [{ "provider": "github", "repository": "fixture/project", "number": 42 }]
            }],
            "provider": { "available": true }
        })).unwrap();
        let wire = to_value(board).unwrap();
        assert_eq!(wire["tasks"][0]["assignee"], json!(null));
        assert_eq!(wire["tasks"][0]["links"][0]["number"], json!(42));
        assert_eq!(wire["provider"]["reason"], json!(null));
    }
}
