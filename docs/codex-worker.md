# Direct Codex workers

The `@praxis/codex-runtime` package runs one ordinary `codex exec --json` process for each assignment. The supported target is the complete Codex CLI 0.172.0-alpha.2 distribution on Linux x64. `capabilities()` reports the observed binary version and platform. A mismatched host or a brief requiring an unavailable capability is refused before the worker starts.

## Local API

Use the built Axiom v1.0.0 runtime at revision `ef35e6f5fb881db878a9547f124f8c28a08b414e`. The executor uses the runtime's Codex adapter and canonical task brief validator. The supported policy is Axiom core v1 with no selected profiles. [Verify and extract the Axiom runtime](desktop-release.md#install)

Construct `new CodexExecutor({ program, axiomRoot, root, model, prepareWorkspace, prepareProfile })` from `@praxis/codex-runtime`. Use absolute local paths for the binary, Axiom checkout and output root. The host's trusted callbacks receive a newly created workspace and fresh Codex and user profile directories. Stage the task files with `prepareWorkspace` and any authorized native configuration with `prepareProfile`. The executor installs and observes Axiom in the fresh Codex profile before submitting the validated brief over stdin.

Pass the matching canonical Praxis task, session and Axiom brief to `createAssignment`. The brief ID must equal the task ID. The native worker receives scope, policy identity, acceptance criteria and limits. The CLI uses workspace-write sandboxing with the fresh workspace as its working directory. The brief supplies file ownership within that workspace. The executor enforces its deadline and task attempt/concurrency limits in the running host.

Read the canonical snapshot and usage with `inspectAssignment`. Native assistant messages appear as a bounded text tail. `stopAssignment` requests termination of the owned process and returns the current observation. `waitAssignment` observes settlement and removes the temporary profile. `completed` requires a native terminal JSONL receipt and a successful CLI exit. `workspaceFor` returns the retained local workspace for result inspection. The owner of the root controls workspace retention.

Assignment references belong to the running executor instance. Resume, compaction, nested worker delegation and remote provider cancellation remain unavailable capabilities. The host can stop its local process. Provider-side billing or execution after disconnect needs separate evidence.

## Delegate from the packaged Manager

Configure the named Hermes Manager, its MCP authority and local [operator access](approvals.md#configure-operator-access). Enroll the task and destination session in the same operational store. Grant the Manager `task.delegate` for that task. Use a clean local Git checkout at the enrolled commit and a dedicated Codex profile. Set `PRAXIS_CODEX_DELEGATION_FILE` in the desktop launch environment to the operator-owned JSON file. Set paths to their absolute local values.

```json
{
  "schemaVersion": 1,
  "axiomRoot": "/absolute/path/to/pinned-built-axiom",
  "evidenceRoot": "/absolute/path/to/trusted-evidence",
  "workerRoot": "/absolute/path/to/retained-workers",
  "program": "/absolute/path/to/complete-codex-package/bin/codex",
  "profile": { "root": "/absolute/path/to/dedicated-account", "model": "entitled-model", "authentication": "file" },
  "assignments": [{
    "taskId": "task_bounded_edit",
    "sessionId": "session_bounded_edit",
    "sourceRevision": "0123456789abcdef0123456789abcdef01234567",
    "authority": {
      "revision": 1,
      "root": "/absolute/path/to/disposable-repository",
      "brief": {
        "id": "task_bounded_edit",
        "objective": "Make the approved change to the fixture",
        "ownedPaths": ["src/fixture.txt"],
        "policy": { "version": "1", "digest": "sha256:2e968204a73b3d6384af8ff0687c8126c3ef798725f4d566ccbf655151ebcc78", "profiles": [] },
        "criteria": [{ "id": "fixture-check", "description": "Pass the protected fixture check", "required": true }],
        "requiredCapabilities": ["process-execution", "policy-loading"],
        "limits": { "timeoutMs": 110000, "maxAttempts": 1, "maxConcurrency": 1 }
      },
      "requirements": [{ "id": "check", "criterionId": "fixture-check", "kind": "automated",
        "command": { "docs": [{ "path": "README.md", "heading": "Verification" }] } }],
      "protectedPaths": ["checks/accept.mjs"],
      "verificationHost": { "agent": "praxis", "version": "v24.22.3", "model": "local", "os": "linux-x64", "surface": "cli" },
      "reviewerId": "principal_operator"
    }
  }]
}
```

Use file-based native login for account profiles. The host stages `auth.json` and an optional native `config.toml` in a disposable Codex home. A credential-free fixture may set `authentication` to `none` and use its own `config.toml`. Keep the dedicated profile, source checkout, Axiom build, worker state and verification evidence in separate roots. Keep the two authority files and the operational database outside the source and worker roots. Packaged assignments use Codex's workspace-write policy with the default temporary roots, additional writable roots and tool network access disabled. [Native account setup](#opt-in-account-verification) · [Task authority and protected checks](effective-policy.md) · [Pinned Codex sandbox policy](https://github.com/openai/codex/blob/rust-v0.172.0-alpha.2/codex-rs/protocol/src/protocol.rs#L1363)

Ask the named Manager to delegate the enrolled task. Open **Activity**, inspect the pending request and approve the exact action once. The detached host checks the approval, grant, policy, configured runtime and Git source immediately before launching. A known refusal or ambiguous launch cannot be replayed as a fresh start. **Overview** displays the registered Codex run and its observed output and metering. Closing Praxis leaves an already-started run active. If an active worker stops updating, Overview shows an unknown native state and retains the last observed output. This surface provides read-only observation and has no interactive takeover or guidance.

### Review the settled result

Use the packaged Node runtime and host entry point shown below, or use the equivalent built checkout paths. Supply the same local configuration environment and an operator token through standard input. Keep the MCP database resolution the same as the desktop host. In an interactive shell, read the token without echo and unset it when finished.

```sh
read -rs operator
printf '%s\n' "$operator" | /absolute/path/to/host/bin/node /absolute/path/to/host/app/dist/codex-delegation-runner.js result REQUEST_ID
```

Review the retained worker checkout printed by `result`. Integrate the scoped change into the enrolled checkout and confirm that the integrated result is ready for the protected checks. Capture the source and receipt digests with `review`.

```sh
printf '%s\n' "$operator" | /absolute/path/to/host/bin/node /absolute/path/to/host/app/dist/codex-delegation-runner.js review REQUEST_ID
printf '%s\n' "$operator" | /absolute/path/to/host/bin/node /absolute/path/to/host/app/dist/codex-delegation-runner.js complete REQUEST_ID SOURCE_DIGEST RECEIPT_DIGEST
unset operator
```

Only run `complete` after reviewing the code that the authorized checks will execute. The command uses a disposable home and a limited environment. Axiom verifies the exact integrated result and records completion only when every mandatory criterion has fresh passing evidence. Keep retained workspaces and native evidence private.

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

## Curated skills

Use the trusted executor's `selectedSkills({ task, session, signal })` callback to select exact approved versions for a task and session. Management code can pass `CuratedSkills.read({ skillId, version })` results from the local registry. The native executor checks the selected content digests, stages the selected files in the fresh worker home and cleans them up at settlement. Native discovery exposes their metadata. The worker can open the selected instructions on demand. [Curation authority and publication](mcp.md#curated-skills)

The credential-free native fixture verifies selected and unselected assignments and observes the actual Markdown read through Code Mode.
