fn main() -> Result<(), Box<dyn std::error::Error>> {
    let commands = tauri_build::AppManifest::new().commands(&[
        "host_status",
        "retry_host",
        "unlock_reports",
        "lock_reports",
        "read_reports",
        "save_report_preferences",
        "clear_report_history",
        "read_settings",
        "save_settings",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))?;
    Ok(())
}
