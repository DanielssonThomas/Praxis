use std::env;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let destination = env::args_os()
        .nth(1)
        .ok_or("Supply an IPC bindings destination.")?;
    praxis_desktop::export_ipc_bindings(destination)?;
    Ok(())
}
