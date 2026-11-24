# Session overview

Run `/overview` or `/o` from the Manager view to open up to ten registered sessions. Each pane shows the task title, ticket or Praxis task ID, observed status and the latest bounded native output. Expand a pane to see its available usage and session ID. Expanding another pane closes the previous one.

Overview uses the local [operator and Hermes configuration](approvals.md). Add the native `assignment` handle for each session to its grant in the [MCP authority file](mcp.md). The local store supplies the registered task and session identities. Credentials stay on the host.

Set `PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID` to the configured manager principal from that same authority file. The most recent unresolved session-targeted activity from that principal highlights only its matching visible pane. The highlight clears when the activity resolves. The Activity panel and Overview read the same persisted event lifecycle.

Native output reads resume from the recent event sequence. Hermes can expire an unconsumed buffer. Overview reports unavailable output or an omitted prefix when the native stream cannot supply the full excerpt. An authoritative final receipt supplies available terminal output. Native usage is displayed when the run reports it.

After building, set `PRAXIS_HERMES_BIN` and run `npm run test:overview:live`. The target fixture exercises the mounted Manager view, ten real Hermes runs, native output, Chromium motion preferences and a configured manager principal submitting its action through native MCP. The full Manager conversation is tracked in [#8](https://github.com/DanielssonThomas/Praxis/issues/8).
