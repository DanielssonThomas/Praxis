# Praxis

Praxis is a local-first workstation for managing parallel Hermes agent sessions. The current workspace contains the development setup, shared contracts and a local operational store. Track application and manager integration delivery in [epic #1](https://github.com/DanielssonThomas/Praxis/issues/1) and [epic #2](https://github.com/DanielssonThomas/Praxis/issues/2).

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
