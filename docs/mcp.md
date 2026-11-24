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

Each write carries a caller-generated `submissionId` using the event ID format. Retry with the same identifier, timestamp and data to reuse the original record. The server derives the durable identity from the authenticated principal. Reusing the identifier with different content produces a conflict. The caller supplies `occurredAt` as reported event time. Approval enforcement and expiry require their own server-owned time.

Run `npm test` for the MCP protocol round trip and scope checks. Run `npm run test:mcp:live` with `PRAXIS_HERMES_BIN` set to an installed Hermes executable to exercise the built MCP entry point from a native Hermes run. The live fixture was verified with Hermes Agent v0.23.3 on Linux at `caafe5389ae585ef77387a962aee05b1bcf17029`.
