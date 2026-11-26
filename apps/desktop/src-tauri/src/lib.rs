mod commands;
mod services;
mod state;

use state::host::ManagedHost;
use tauri::{Manager, RunEvent};

pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().resource_dir()?.join("host");
            app.manage(ManagedHost::start(root)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::host::host_launch_status,
            commands::host::retry_host
        ])
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                app.state::<ManagedHost>().shutdown();
            }
        });
    Ok(())
}
