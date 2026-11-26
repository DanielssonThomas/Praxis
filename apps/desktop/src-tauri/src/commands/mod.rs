pub(crate) mod host;
pub(crate) mod kanban;

use tauri::Wry;
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands};

pub(crate) fn registry() -> Builder<Wry> {
    Builder::new()
        .commands(collect_commands![
            host::host_status,
            host::retry_host,
            kanban::kanban_list,
            kanban::kanban_unlock,
            kanban::kanban_lock,
            kanban::kanban_link_issue,
            kanban::kanban_open_issue
        ])
        .error_handling(ErrorHandlingMode::Result)
}
