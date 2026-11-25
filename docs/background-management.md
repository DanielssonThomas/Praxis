# Background management

Praxis schedules background management in an independent local process while Hermes runs the manager turns. Use a separate named Hermes profile configured with a dedicated read-only Praxis MCP principal. Give that principal only the task and session IDs it needs. Set `actionKinds` to an empty array and `canReport` to false on its session grants. Set `canWrite` to false on any memory project grants. Start MCP with that grant already in place, and give the native background profile only its matching MCP credential. The worker returns advisory text. The operator continues to use the ordinary activity and approval paths for scoped actions. [Hermes profile setup](hermes-manager.md) · [MCP authority](mcp.md)

## Run the queue

Build Praxis. Use the same local `PRAXIS_MCP_CONFIG_FILE` as MCP and the shell. Set `PRAXIS_BACKGROUND_HERMES_ORIGIN` to the named local gateway URL, such as `http://127.0.0.1:8642/p/praxis-background`. Set `PRAXIS_BACKGROUND_HERMES_API_KEY` to its native API bearer and `PRAXIS_BACKGROUND_PRINCIPAL_ID` to its read-only MCP principal. Supply credentials through local host configuration.

Run `npm run management`. `PRAXIS_BACKGROUND_CONCURRENCY` defaults to 2 and supports 1–10. `PRAXIS_BACKGROUND_MAX_ATTEMPTS` defaults to 3 and supports 1–5. Use one consistent configuration for workers sharing the database. The queue binds to its configured native profile and principal so a restart on another profile cannot redispatch a stale native turn. The foreground and background services use independent native conversations.

Authorized `report_worker` question, result and blocker events enter the queue automatically. Ordinary progress reports stay in their existing journal. To enqueue host-authorized direction or maintenance, save a local JSON file and run `npm run management -- enqueue /absolute/path/to/work.json`. Use a stable event ID for an exact retry.

```json
{
  "id": "event_background_example",
  "taskId": "task_registered_example",
  "kind": "direction",
  "instruction": "Review the worker handoff before continuing routine maintenance."
}
```

Direction comes ahead of waiting worker reports and maintenance. Active native turns retain their slots. `npm run management -- list` reads local work states and advisory results. These records can contain task text. `npm run management -- usage` reads distinct native management receipts. General Reports retains its existing worker usage projection.

## Recovery and review

SQLite preserves input identity, attempt number, native run ID and claim ownership. A worker reclaims an expired 60-second lease and polls its saved run. With an unacknowledged submission it reuses the same turn identifier and input within the verified Hermes idempotency window. A confirmed terminal failure can use a new attempt after a delay.

An exhausted attempt creates **Needs human review** in Activity. Repeated native failures with an unknown execution outcome also produce a review card. That item holds its concurrency slot until the native outcome is investigated, so recovery cannot start an additional speculative turn. The coordinator stops automated submission replay before the native key can expire. Review cards carry the original work and task identity and grant no execution authority.

## Verification

Run `npm test` for claim, retry and failure cases. After building, set `PRAXIS_HERMES_BIN` to pinned Hermes Agent v0.23.3 and run `npm run test:management:live`. The isolated loopback fixture verifies actual MCP worker reports, denied native background action requests, independent foreground progress, restart and separate metering.
