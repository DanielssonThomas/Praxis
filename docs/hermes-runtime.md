# Hermes runtime adapter

`@praxis/hermes-runtime` connects to a separately running Hermes gateway on an explicit loopback origin. Enable the native API server with bearer authentication. Pass its origin and API credential to `HermesRuntime` from the local host. Keep the credential outside the browser and portable Praxis settings.

`createAssignment` accepts a canonical Praxis session and a prompt, and returns a reference containing its Praxis task ID, session ID and Hermes run ID. A Praxis task and session pair identifies one Hermes run in a dedicated native API session. Keep the returned reference for inspection after reconnect. Identical submission retries use the same Hermes idempotency key during the upstream retention window. Use a new Praxis session for a new assignment.

`inspectAssignment` returns the canonical runtime snapshot from a native run receipt. The adapter bounds the output tail and reports missing output or unrecognized state explicitly. `stopAssignment` first verifies that the native run belongs to the requested Praxis session, then invokes Hermes's exact-run stop endpoint. The native `stopping` acknowledgment indicates a request. Poll the run to observe a settled `stopped` status. Closing the Praxis UI or its local web host leaves the independent Hermes process running.

`capabilities` checks the advertised Hermes API flags for submission, inspection and stop. This adapter exposes run receipts. Live output streaming, attaching to non-API sessions, and operating a Kanban board require separate integrations. Hermes retains native run and idempotency receipts according to its own documented limits. The adapter leaves dispatch, execution and cancellation with Hermes. See the [pinned Runs reference](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/features/api-server.md#runs-api-streaming-friendly-alternative).

## Live verification

Build the workspace, install a Chromium browser, and set `PRAXIS_HERMES_BIN` to an installed Hermes executable with the messaging dependencies. Run `npm run test:hermes`. Set `PRAXIS_TEST_CHROMIUM` for a system Chromium executable. The test creates a disposable profile, credentials and scripted provider on loopback. It launches the real Hermes gateway and the built Praxis shell, then verifies bearer denial, idempotent submission, UI and web host restart, exact-run stop and completed output.

The verified combination is Hermes Agent v0.23.3 at `caafe5389ae585ef77387a962aee05b1bcf17029`, Python 3.14.10, Node.js 24.22.3 and Chromium 156.0.8078.79 on Linux x64. The scripted provider verifies the native gateway lifecycle without external model calls. Host and provider combinations outside that fixture remain unverified.
