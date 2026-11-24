# Native Kanban and issue links

Run `/kanban` in the shell and open the board with your operator token. **Refresh board** rereads the selected native Hermes board. The columns reflect the status reported by Hermes. Use Hermes for native board operations and dispatch.

## Configure the local view

- Set `PRAXIS_KANBAN_HERMES_HOME` to the selected Hermes home. Set `PRAXIS_KANBAN_HERMES_BIN` when its executable is outside PATH and `PRAXIS_KANBAN_BOARD` when selecting a board other than `default`.
- Use the operational database from `PRAXIS_MCP_CONFIG_FILE`, or set `PRAXIS_KANBAN_DATABASE` for a board-only local setup. When both are set, they must point to the same database.
- Set `PRAXIS_OPERATOR_TOKEN_DIGEST` to the SHA-256 hex digest of the operator token. The local browser and operator authorization are shared with [scoped approvals](approvals.md).
- Set `PRAXIS_GITHUB_TOKEN` to a credential with issue read access. The issue provider is unavailable without a credential. For a disposable loopback provider fixture, set `PRAXIS_GITHUB_API_ORIGIN`.

Enter an issue as `owner/repo#42` on its task card. Praxis confirms the exact issue through the GitHub API and records one local link event for the association. Existing links remain visible across native state changes. The Hermes profile and board identify the task's local projection. GitHub issue contents, PR activity and native status changes remain with their respective providers.

## Verification

After building, run `npm test` for projection, provider denial, input validation and durable replay cases. Set `PRAXIS_HERMES_BIN` and run `npm run test:kanban:live` for the browser, real Hermes CLI and an authenticated loopback GitHub API fixture. It verifies native ready → blocked → ready transitions, operator scope, the exact provider lookup and persisted issue identity.

The live fixture uses Hermes Agent v0.23.3 at `caafe5389ae585ef77387a962aee05b1bcf17029`, Python 3.14.10, Node.js 24.22.3 and Chromium 156.0.8078.79 on Linux x64.
