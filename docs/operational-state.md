# Local operational state

Open `OperationalStore` from `@praxis/state` with a SQLite database file in a caller-owned directory. Node.js 24 provides SQLite. The store accepts task, session, event and usage records through the canonical schemas in `@praxis/contracts`. Close the store when the host shuts down and reopen the same file to read saved records by ID.

Create a task before recording its sessions and a session before recording its usage. Event subjects can refer to records held by other services or projected later. `eventsFor` returns saved events for a subject in insertion order. Runtime adapters and projections interpret event kinds such as `task.failed`.

Worker reports and pending action requests can include canonical event details. The MCP server stamps the authenticated principal into these details. Existing records without details remain valid.

Record writes return `inserted` for a new identity and `duplicate` when the canonical record already exists. Distinct content with the same ID raises `identity_conflict`. SQLite enforces unique IDs across connections, and every event and usage identity contributes at most one record. Use a stable ID when replaying the same observation. A measured zero remains a measurement, while unavailable usage preserves the source's reason.

A lookup for a valid ID with no record returns `undefined`. Invalid input, missing references, unsupported database versions and storage failures raise `OperationalStoreError` with distinct codes. All storage activity stays in the caller's local database. The package makes no telemetry or network calls.
