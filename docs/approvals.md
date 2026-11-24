# Scoped approvals

The Activity panel reviews requests submitted through [Praxis MCP](mcp.md). One card follows each request from processing to its decision or outcome. The configured local host resolves granted `session.inspect` requests in bounded passes within scope. Inspecting a granted `session.stop` request moves the card to **Needs attention** and offers **Approve once** and **Deny**.

## Configure operator access

Run the shell with `PRAXIS_MCP_CONFIG_FILE`, `PRAXIS_HERMES_ORIGIN`, and `PRAXIS_HERMES_API_KEY` set to the same authority file and Hermes gateway used for the MCP integration. The authority file must bind the requested session to its native assignment and include the requested action kind.

Generate a separate high-entropy operator token and pass its lowercase SHA-256 hex digest as `PRAXIS_OPERATOR_TOKEN_DIGEST`. Open **Activity** and enter the operator token. The browser holds it in memory until the panel is locked or the page is closed. The shell keeps the native Hermes credential on the local host. An MCP worker token cannot unlock Activity, and the service rejects authority files that reuse the operator digest for a worker.

## Decisions and native outcomes

An approval binds to one canonical action, exact target session, corresponding native assignment and issuing actor grant. It expires after five minutes measured on the host. The service rereads trusted scope before execution and makes a final check before sending the exact native stop. An observed scope change or expiry records a durable invalidation for that request.

SQLite records one decision or execution claim per action across host processes. Denial leaves the native run untouched. A retry of an existing decision cannot issue another stop. A durable execution claim without a verified native receipt remains **Execution unverified** after restart. When Hermes acknowledges stopping, the card states that it has requested a stop and is awaiting a settled native outcome.

Run `npm test` for the scope, expiry, replay and recovery cases. Set `PRAXIS_HERMES_BIN` and run `npm run test:approval:live` after building to verify the Activity panel with two real Hermes runs and an isolated provider. The verified combination uses Hermes Agent v0.23.3 at `caafe5389ae585ef77387a962aee05b1bcf17029`, Python 3.14.10, Node.js 24.22.3 and Chromium 156.0.8078.79 on Linux x64.
