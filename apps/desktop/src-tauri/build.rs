fn main() -> Result<(), Box<dyn std::error::Error>> {
    let commands = tauri_build::AppManifest::new().commands(&[
        "host_status",
        "retry_host",
        "kanban_list",
        "kanban_unlock",
        "kanban_lock",
        "kanban_link_issue",
        "kanban_open_issue",
        "unlock_manager",
        "lock_manager",
        "manager_turn",
        "unlock_overview",
        "lock_overview",
        "read_overview",
        "control_session",
        "unlock_activity",
        "lock_activity",
        "read_activity",
        "inspect_activity",
        "decide_activity",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(commands))?;
    Ok(())
}
