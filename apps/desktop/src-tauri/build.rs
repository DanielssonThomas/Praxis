fn main() -> Result<(), Box<dyn std::error::Error>> {
    let commands = tauri_build::AppManifest::new().commands(&[
        "host_status",
        "retry_host",
        "unlock_manager",
        "lock_manager",
        "manager_turn",
        "unlock_overview",
        "lock_overview",
        "read_overview",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))?;
    Ok(())
}
