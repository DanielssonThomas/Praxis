# Praxis MCP

Praxis MCP is a local Streamable HTTP interface for inspecting operational state, recording worker reports and submitting scoped action requests. It reuses the local SQLite store and the native Hermes runtime adapter.

## Start the local service

After building, run `npm run mcp` with `PRAXIS_MCP_CONFIG_FILE` set to a user-owned authority file. The default endpoint is `http://127.0.0.1:3211/mcp`. Set `PRAXIS_MCP_PORT` to change the loopback port.

```json
{
  "schemaVersion": 1,
  "database": "./operational.sqlite",
  "grants": [
    {
      "principalId": "principal_build",
      "tokenDigest": "<sha256-hex>",
      "taskIds": ["task_build"],
      "sessions": [{ "sessionId": "session_build", "canReport": true }],
      "actionKinds": ["session.stop"]
    }
  ]
}
```

Use a separate high-entropy token for each principal. Set `tokenDigest` to the token's lowercase SHA-256 hex digest, and pass the token to the intended host through its local credential configuration. The server reads grants at startup. Grant only the task and session IDs needed by each principal.

In Hermes, point the profile's MCP server entry at the loopback endpoint and send its token using the `Authorization` header. [Hermes MCP HTTP configuration](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/features/mcp.md#http-servers)

For native inspection, set `PRAXIS_HERMES_ORIGIN` and `PRAXIS_HERMES_API_KEY` in the MCP process. Attach the assignment reference returned by `createAssignment` to the corresponding session grant's `assignment` field. The service checks session and task identity before returning a native snapshot. Missing bindings or runtime configuration produce an explicit unavailable status.

## Tools

| Tool | Scope and result |
| --- | --- |
| `inspect_task` | Read a canonical task in the principal's task scope. |
| `inspect_worker` | Read a scoped worker session and its native runtime snapshot when available. |
| `report_worker` | Record a progress, result or blocked event for a session with `canReport`. |
| `request_action` | Persist a pending action request for a granted kind and target. The [approval service](approvals.md) owns execution. |

Each operational write carries a caller-generated `submissionId` using the event ID format. Retry with the same identifier, timestamp and data to reuse the original record. The server derives the durable identity from the authenticated principal. Reusing the identifier with different content produces a conflict. The caller supplies `occurredAt` as reported event time. Approval enforcement and expiry require their own server-owned time.

Run `npm test` for the MCP protocol round trip and scope checks. Run `npm run test:mcp:live` with `PRAXIS_HERMES_BIN` set to an installed Hermes executable to exercise the built MCP entry point from a native Hermes run. The live fixture was verified with Hermes Agent v0.23.3 on Linux at `caafe5389ae585ef77387a962aee05b1bcf17029`.

## Project memory

Opt in by adding `"memory": { "directory": "./engineering-memory" }` at the top level of the MCP authority file. Relative memory paths resolve from the authority file's directory. Add `"memoryProjects": [{ "projectId": "my-project", "canWrite": true }]` to the manager's grant. Use `false` for read-only access and omit the grant from principals without access. Restart MCP after editing the authority file. Project and note IDs use lowercase letters, digits and hyphens.

| Tool | Scope and result |
| --- | --- |
| `retrieve_memory` | List recent notes, search their content with `query`, or retrieve a `noteId` within a granted `projectId`. |
| `record_memory` | Save a `decision` or `finding` with a project ID, note ID, title, and Markdown body. Supply `verification` for a finding and `relatedNoteIds` for links to existing notes in the same project. The manager supplies the verification evidence. Retrying the same note content returns the existing record. |

Praxis stores each note as Markdown under `<projectId>/<noteId>.md`, with relative Markdown links. Open the chosen directory as an existing Obsidian vault or use any Markdown editor. Keep the Praxis note header when editing the prose so Praxis can index the note. The operational SQLite database stays separate. A small hidden writer-lock file in the vault contains no project or task data.

Turn off **Enable engineering memory** in Settings to pause MCP reads and writes without deleting notes. Only the local operator can export or prune through the MCP command line. Export preserves Markdown bytes and relative links in a new directory. Prune permanently removes Praxis notes dated before the UTC cutoff you specify. Export first if you need those notes later. Both commands work while the manager's memory tools are disabled.

```sh
npm run mcp -- memory export /absolute/path/to/new-export
npm run mcp -- memory prune 2026-01-01
```
