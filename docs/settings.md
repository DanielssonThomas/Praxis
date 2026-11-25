# Portable settings

Run `npm run build` and `npm start` from the workspace, then open `http://127.0.0.1:3210/settings`. Set `PRAXIS_PORT` to change the loopback port.

The editor reads and saves one versioned JSON file at `$XDG_CONFIG_HOME/praxis/settings.json` or `~/.config/praxis/settings.json`. Set `PRAXIS_CONFIG_FILE` to use a different file. A fresh install reads defaults and creates the file on the first save. Move or back up this file to transfer the preferences, and use the settings screen or a text editor to update it. The settings service validates the full document before saving and preserves the previous file when validation fails.

The file records selected Axiom profiles, the Hermes manager profile and model, worker runtime and model preferences, optional task budget caps, engineering memory, and automatic visual presentation. A blank model follows the selected runtime's default. An unset budget leaves the corresponding Praxis cap unspecified.

The [Reports view](reports.md) can add local reporting preferences to the same file. Existing configuration files without these preferences use report defaults. Saving through the general editor preserves report preferences and history settings.

Only the declared preference fields are accepted. Keep tokens and other credentials in the selected host's native credential configuration. Axiom, memory and automatic presentation have independent preferences. Host authentication and permissions apply regardless of the Axiom setting. Runtime integrations own profile activation, model availability and budget enforcement.

Engineering memory requires a user-selected directory and manager project grant in the MCP authority file. Turn off **Enable engineering memory** to pause manager access and retain the notes. [Project memory setup](mcp.md#project-memory)
