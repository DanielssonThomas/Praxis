mod commands;
mod models;
mod services;
mod state;

use services::host_http::HostClient;
use specta_typescript::Typescript;
use state::host::ManagedHost;
use state::manager_stream::ManagerStreams;
use state::operator::OperatorSessions;
use std::path::Path;
use tauri::{Manager, RunEvent};

pub fn export_ipc_bindings(destination: impl AsRef<Path>) -> Result<(), specta_typescript::Error> {
    commands::registry().export(Typescript::default(), destination)
}

pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().resource_dir()?.join("host");
            app.manage(HostClient::new()?);
            app.manage(ManagedHost::start(root)?);
            app.manage(OperatorSessions::default());
            app.manage(ManagerStreams::default());
            Ok(())
        })
        .invoke_handler(commands::registry().invoke_handler())
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                app.state::<ManagedHost>().shutdown();
            }
        });
    Ok(())
}
