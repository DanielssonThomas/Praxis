# Direct Codex workers

The `@praxis/codex-runtime` package runs one ordinary `codex exec --json` process for each assignment. The supported target is the complete Codex CLI 0.172.0-alpha.2 distribution on Linux x64. `capabilities()` reports the observed binary version and platform. A mismatched host or a brief requiring an unavailable capability is refused before the worker starts.

## Local API

Build Praxis and a clean checkout of Axiom at `96014e73ca14111be83c448898e41559f0f87f88`. The executor uses that checkout's built Codex adapter and canonical task brief validator. The first supported policy is Axiom core v1. A brief with a different policy identity or selected profiles is refused.

Construct `new CodexExecutor({ program, axiomRoot, root, model, prepareWorkspace, prepareProfile })` from `@praxis/codex-runtime`. Use absolute local paths for the binary, Axiom checkout and output root. The host's trusted callbacks receive a newly created workspace and fresh Codex and user profile directories. Stage the task files with `prepareWorkspace` and any authorized native configuration with `prepareProfile`. The executor installs and observes Axiom in the fresh Codex profile before submitting the validated brief over stdin.

Pass the matching canonical Praxis task, session and Axiom brief to `createAssignment`. The brief ID must equal the task ID. The native worker receives scope, policy identity, acceptance criteria and limits. The CLI uses workspace-write sandboxing with the fresh workspace as its working directory. The brief supplies file ownership within that workspace. The executor enforces its deadline and task attempt/concurrency limits in the running host.

Read the canonical snapshot and usage with `inspectAssignment`. Native assistant messages appear as a bounded text tail. `stopAssignment` requests termination of the owned process and returns the current observation. `waitAssignment` observes settlement and removes the temporary profile. `completed` requires a native terminal JSONL receipt and a successful CLI exit. `workspaceFor` returns the retained local workspace for result inspection. The owner of the root controls workspace retention.

Assignment references belong to the running executor instance. Resume, compaction, nested worker delegation and remote provider cancellation remain unavailable capabilities. The host can stop its local process. Provider-side billing or execution after disconnect needs separate evidence.

## Verify

Extract `codex-package-x86_64-unknown-linux-musl.tar.gz` from the pinned release and keep its directory layout intact. Use the extracted `bin/codex` for `PRAXIS_CODEX_BIN` and device authorization. Code Mode loads its companion `codex-code-mode-host` from the distribution. [Pinned Codex release](https://github.com/openai/codex/releases/tag/rust-v0.172.0-alpha.2)

The scripted fixture uses a real Codex process with an isolated loopback Responses provider that needs no credentials. It verifies a native Code Mode read of a scoped workspace file.

```sh
npm run build
PRAXIS_CODEX_BIN=/absolute/path/to/extracted-package/bin/codex \
PRAXIS_AXIOM_ROOT=/absolute/path/to/pinned-built-axiom \
npm run test:codex:live
```

### Opt-in account verification

Use a dedicated, private Codex home for an account you are authorized to use. Set file-based credential storage in that home's `config.toml`.

```toml
cli_auth_credentials_store = "file"
```

Complete the pinned CLI's native device authorization in the dedicated home. The native CLI saves its login in that home's `auth.json`.

```sh
CODEX_HOME=/absolute/path/to/authorized-account-home \
  /absolute/path/to/extracted-package/bin/codex login --device-auth
```

From the built Praxis checkout, select the same home and a model the account is entitled to use. Keep the configured proxy and certificate environment in place. The probe checks for the login file before starting the worker, stages the native login and optional configuration in a temporary profile, verifies the scoped file result, and records host and outcome metadata.

```sh
PRAXIS_RUN_CODEX_ACCOUNT=1 \
PRAXIS_CODEX_BIN=/absolute/path/to/extracted-package/bin/codex \
PRAXIS_AXIOM_ROOT=/absolute/path/to/pinned-built-axiom \
PRAXIS_CODEX_ACCOUNT_HOME=/absolute/path/to/authorized-account-home \
PRAXIS_CODEX_MODEL=entitled-model \
node --test tests/runtime/codex.account.mjs
```
