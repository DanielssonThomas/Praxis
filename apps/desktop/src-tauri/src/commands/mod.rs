pub(crate) mod host;

use tauri::Wry;
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands};

pub(crate) fn registry() -> Builder<Wry> {
    Builder::new()
        .commands(collect_commands![host::host_status, host::retry_host])
        .error_handling(ErrorHandlingMode::Result)
}
