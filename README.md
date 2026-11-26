# Praxis

Praxis is a local-first workstation for managing parallel Hermes agent sessions. The v1 desktop product uses Angular and Tauri with the existing local Node host. Track application and manager integration delivery in [epic #1](https://github.com/DanielssonThomas/Praxis/issues/1) and [epic #2](https://github.com/DanielssonThomas/Praxis/issues/2).

## Development

Use the Node.js release in [.node-version](.node-version) with its bundled npm. Run these commands from a clean checkout:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`npm test` builds the workspace before running tests against its public package APIs. The [CI workflow](.github/workflows/ci.yml) runs the same commands on a fresh Linux runner.

Read [contributor instructions](AGENTS.md) before working on an issue. See the [architecture](docs/architecture.md) for the runtime and contract boundaries and the [Hermes feasibility review](docs/hermes-feasibility.md) for native integration candidates and open checks.

## Desktop development

Run `npm run start:desktop` to develop the Angular shell. Open **Menu** to switch views, or run `/help` in the command bar. See [desktop development and UI checks](docs/desktop.md).

Run `npm start` after building to run the Node host and its existing browser shell. See [host navigation and browser checks](docs/shell.md) and [portable settings](docs/settings.md).

See the [Hermes manager setup](docs/hermes-manager.md) to install the named Linux manager profile and connect it to Praxis MCP.

The local worker API can run direct Codex assignments on the pinned Linux host. [Direct Codex workers](docs/codex-worker.md)
