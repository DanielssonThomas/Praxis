pub(crate) mod host;
mod reports;
mod settings;

use tauri::Wry;
use tauri_specta::{Builder, ErrorHandlingMode, collect_commands};

pub(crate) fn registry() -> Builder<Wry> {
    Builder::new()
        .commands(collect_commands![
            host::host_status,
            host::retry_host,
            reports::unlock_reports,
            reports::lock_reports,
            reports::read_reports,
            reports::save_report_preferences,
            reports::clear_report_history,
            settings::read_settings,
            settings::save_settings,
        ])
        .error_handling(ErrorHandlingMode::Result)
}
