# Hermes runtime adapter

`@praxis/hermes-runtime` connects to a separately running Hermes gateway with its native API server and bearer authentication enabled. Set `PRAXIS_HERMES_ORIGIN` and `PRAXIS_HERMES_API_KEY` on the local Praxis process. Direct callers pass the same values as `origin` and `apiKey` to `HermesRuntime`. Keep the bearer in local host configuration, outside the URL, browser and portable Praxis settings.

| Hermes route | Example `PRAXIS_HERMES_ORIGIN` |
| --- | --- |
| Default profile | `http://127.0.0.1:8642` |
| Named profile on a multiplexed gateway | `http://127.0.0.1:8642/p/praxis-manager` |

Use an HTTP(S) URL with a loopback IP such as `127.0.0.1` or `[::1]`. A profile name follows Hermes's lowercase identifier format with up to 64 characters. It starts with a letter or digit and may also contain underscores and hyphens. The base URL may end with a single slash. For a named route, configure that profile's API bearer. Praxis sends every request through the selected prefix, including streaming, run control and transcript reads. [Hermes multi-profile API routing](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/features/api-server.md#multi-profile-routing-pprofile)

`createAssignment(session, prompt)` submits a single assignment with its existing native session and idempotency key. `submitTurn(session, prompt, turnId)` submits an explicitly identified turn. Calls with different turn IDs for the same task, session and profile share a conversation and return separate run references. Both APIs return the Praxis task ID, session ID and native run ID.

For a multi-turn conversation on a named profile, use `submitTurn` from the first turn. Explicit turns use a dedicated native session scoped to that profile. Switching an existing named conversation from `createAssignment` to `submitTurn` starts a separate native conversation. Existing assignment references still address their original sessions. The unprefixed default route and `/p/default` share the default session identity.

Choose a stable `turnId` before submitting a turn. It takes 1–128 ASCII characters, starts with a letter or digit, and may also contain periods, underscores or hyphens. Use a new ID for a new turn, even if the prompt repeats. To retry, reuse the session, turn ID, unchanged prompt and the same profile credential. Hermes returns the original run within its retention window. On the pinned host, Hermes retains each key for 24 hours after its last run status update. A changed prompt with the same key is refused as HTTP 409, surfaced by Praxis as `native_refused`. Keep the run reference for inspection and reconcile uncertain older submissions before retrying beyond Hermes's retention window. [Hermes Runs submission and retries](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/features/api-server.md#post-v1runs)

`inspectAssignment` returns the canonical runtime snapshot from a native run receipt. The adapter bounds the output tail and reports missing output or unrecognized state explicitly. `stopAssignment` first verifies that the native run belongs to the requested Praxis session, then invokes Hermes's exact-run stop endpoint. The native `stopping` acknowledgment indicates a request. Poll the run to observe a settled `stopped` status. Closing the Praxis UI or its local web host leaves the independent Hermes process running.

`capabilities` checks the advertised Hermes API flags for submission, inspection, stop and streaming. `inspectLiveAssignment` reads the run receipt together with available token usage and bounded live output. Native event cursors use `Last-Event-ID` on reconnect. An expired buffer or unsupported stream remains explicitly unavailable. This surface uses API sessions. The separate [Kanban view](kanban.md) reads native boards.

Hermes retains native run and idempotency receipts according to its documented limits and owns dispatch, execution and cancellation. [Pinned Runs reference](https://github.com/NousResearch/hermes-agent/blob/caafe5389ae585ef77387a962aee05b1bcf17029/website/docs/user-guide/features/api-server.md#runs-api-streaming-friendly-alternative)

## Live verification

Build the workspace, install a Chromium browser, and set `PRAXIS_HERMES_BIN` to an installed Hermes executable with the messaging dependencies. Run `npm run test:hermes`. Set `PRAXIS_TEST_CHROMIUM` for a system Chromium executable. The test creates a disposable profile, credentials and scripted provider on loopback. It launches the real Hermes gateway and the built Praxis shell, then verifies bearer denial, idempotent submission, UI and web host restart, exact-run stop and completed output.

The verified combination is Hermes Agent v0.23.3 at `caafe5389ae585ef77387a962aee05b1bcf17029`, Python 3.14.10, Node.js 24.22.3 and Chromium 156.0.8078.79 on Linux x64. The scripted provider verifies the native gateway lifecycle without external model calls. Host and provider combinations outside that fixture remain unverified.

To verify named routing on the same pinned Hermes source checkout, build Praxis, set `PRAXIS_HERMES_BIN`, and run `node --test tests/runtime/hermes-profile-routing.live.mjs`. The fixture starts a disposable multiplexed gateway and two named profiles with separate synthetic bearers and a scripted loopback provider. It checks native assignment completion through the adapter and the configured Praxis Overview, plus rejection of foreign credentials, inspection and stop. The follow-up case also verifies native history, separate session and profile scope, and retry deduplication before and after a gateway restart.
