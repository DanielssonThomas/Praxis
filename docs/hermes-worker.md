# Install a Praxis Hermes worker

The optional worker profile targets Hermes Agent 0.23.3 at `caafe5389ae585ef77387a962aee05b1bcf17029` on Linux x64. It uses a dedicated native home and a scoped Praxis MCP principal. Each worker can inspect its assigned work and submit findings and skill proposals. The default profile uses the pinned Axiom core through the same native installer as the [Praxis Hermes manager](hermes-manager.md).

## Install or replace

Build Praxis with `npm ci` and `npm run build`. Use the extracted [Axiom v1.0.0 runtime](desktop-release.md#install) as the pinned Axiom dependency.

```sh
node scripts/install-hermes-worker.mjs \
  --hermes-bin /absolute/path/to/hermes \
  --hermes-home /absolute/path/to/dedicated-worker-root \
  --profile praxis-worker-one \
  --axiom-root /absolute/path/to/built-axiom
```

Give each concurrent worker its own empty root and profile name. The installer creates the profile without copying credentials, sessions, skills, or aliases from the active Hermes installation. Use `--mcp-origin http://127.0.0.1:PORT/mcp` for a different local Praxis MCP port.

Reinstalls preserve the profile's `SOUL.md` and existing native MCP configuration. Pass `--replace` to reinstall the worker personality and update the managed Axiom bundle. Your model configuration, local credentials, and native conversation history remain usable. Open a new native session for a changed personality. With `policy.axiomEnabled` disabled in [Praxis settings](settings.md), the installer skips Axiom lifecycle changes and omits the `--axiom-root` requirement. Manage optional policy profiles through Axiom's native lifecycle.

## Connect and run

Create a unique high-entropy bearer for each worker and configure its corresponding grant in the [Praxis MCP authority file](mcp.md). Give the worker its own principal, task, and session IDs. Enable reporting for that session and leave `actionKinds` empty. Keep management and curated-library authority with the owner or manager principal.

```json
{
  "principalId": "principal_worker_one",
  "tokenDigest": "<worker bearer SHA-256 hex digest>",
  "taskIds": ["task_worker_one"],
  "sessions": [{ "sessionId": "session_worker_one", "canReport": true }],
  "actionKinds": []
}
```

1. In the installed profile's `.env`, set `PRAXIS_MCP_TOKEN` to the worker's bearer and `API_SERVER_KEY` to a separate strong gateway bearer. Configure a model and credential in the same profile.
2. Start the [Praxis MCP service](mcp.md). It owns grants and accepts scoped reports while the manager is offline.
3. Start the worker gateway with a unique localhost port and its own root. Keep the gateway bearer in the profile's `.env`.

```sh
HERMES_HOME=/absolute/path/to/dedicated-worker-root \
API_SERVER_ENABLED=true API_SERVER_HOST=127.0.0.1 API_SERVER_PORT=8643 \
hermes -p praxis-worker-one gateway run
```

Submit an assignment through the [Hermes runtime adapter](hermes-runtime.md) at `http://127.0.0.1:8643/p/praxis-worker-one` with the worker's native gateway bearer. Use the same task and session identifiers as the MCP grant and include the objective, allowed scope, limits, and acceptance criteria in the assignment.

The profile exposes task and session inspection and `report_worker`. With the [opt-in curation service](https://github.com/DanielssonThomas/Praxis/issues/22), `propose_skill` accepts evidence-backed proposals and `load_curated_skill` reads the specific approved skill version granted to the session. If the service is unavailable, include a proposed skill and its evidence in the scoped result text. The profile grants no terminal, filesystem, delegation, or native skill maintenance tools. Separate native profiles protect conversation and profile state. Operating-system access is governed by the account running Hermes.

## Verify

With Praxis built, run the fixture against the pinned source launchers. It uses disposable profiles and a scripted local provider.

```sh
PRAXIS_HERMES_BIN=/absolute/path/to/hermes \
PRAXIS_AXIOM_ROOT=/absolute/path/to/built-axiom \
node --test tests/runtime/hermes-worker-install.live.mjs tests/runtime/skill-curation.live.mjs
```

The fixtures exercise concurrent native assignments, profile and conversation isolation, loaded Axiom policy, and authority denials while the manager is offline. The installed worker also exercises scoped proposals and reads the selected published skill version through the curation service.
