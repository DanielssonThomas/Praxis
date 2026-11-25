# Foreground manager

The local Praxis host streams a dedicated conversation with the selected [named Hermes manager](hermes-manager.md). Configure the manager's named `PRAXIS_HERMES_ORIGIN`, its local `PRAXIS_HERMES_API_KEY`, and the existing [operator token and MCP authority](approvals.md). The configured Hermes profile must match `manager.profile` in portable settings. Restart the shell after changing the configuration.

## Use the Manager view

Open **Manager**, enter the local operator token, and type a message in the permanent command bar. Slash commands still navigate the shell while a reply streams. If a connection drops or you lock the Manager, open it again and choose **Reconnect** to resume the current turn. The open tab retains its conversation across view changes and stream reconnects. The operator token stays in memory and is cleared on lock or reload.

Hermes reports tokens for an individual turn when available. The Manager shows those separately and marks the context window and compaction as unavailable.

## Submit and receive output

Use an authenticated `HEAD /api/manager/turn` to check operator access. The valid setup responds with 204 and performs no native operation. Send `POST /api/manager/turn` with the local shell's exact origin, the operator bearer in `Authorization`, and `Content-Type: application/json`. A caller provides a stable turn ID and the prompt.

```json
{
  "turnId": "manager-turn-1",
  "prompt": "Inspect the current assignment and tell me what is missing."
}
```

A successful response is newline-delimited JSON. A `snapshot` record includes `runId`, the accumulated bounded `snapshot` and the runtime's `usage` report. Replace the displayed output with each snapshot. The stream ends at a terminal native status, or with an `error` record if native output becomes unavailable. A malformed or unauthorized request fails before the native turn starts.

Use a new turn ID for a new message. Resubmit the same ID with the original prompt to recover a turn after a disconnect within [Hermes's retention window](hermes-runtime.md). Closing the stream leaves the native turn running. The browser supplies neither a native session identity nor Hermes credentials. The dedicated manager task and session use the reserved identities `task_foreground_manager` and `session_foreground_manager`.

## Live state and actions

The manager reads live state through its installed MCP principal. Use the [MCP authority file](mcp.md) to grant specific tasks, sessions, and action kinds. Out-of-scope reads and requests are refused by MCP. The manager can report missing information explicitly. Background queue integration is tracked in [#18](https://github.com/DanielssonThomas/Praxis/issues/18).

A granted cancel intent records `session.stop` in Activity. The operator must approve the exact action before the existing approval service requests a stop. A granted `task.delegate` or `task.reprioritize` intent records its target in Activity. Those intents have no configured executor in this integration and Activity shows a refusal when reviewed.

## Verify

The [native manager fixture](hermes-manager.md#verify-the-setup) exercises the installed manager, its private stream in Chromium, a read through real Hermes MCP, and a separate running Hermes worker. It observes foreground output before worker completion, navigation and stable-ID reconnect, scoped action recording, and the exact approved worker stop. Its provider is scripted on localhost.
