# Delegated task policy and completion

Praxis applies the pinned Axiom core through the local host. The qualified Manager surface is Hermes Agent 0.23.3 on Linux x64. The qualified worker surface is the direct Codex CLI 0.172.0-alpha.2 on Linux x64. Keep the Axiom build and evidence archive under operator control outside both the integration checkout and native worker workspaces. [Build the pinned Axiom checkout](hermes-manager.md#install) · [Install the complete pinned Codex distribution](codex-worker.md#verify)

Host code opens `EffectivePolicyService` from `@praxis/management` with the operational store, the two absolute Axiom and evidence paths, and loaders for current MCP grants and operator-owned task authority. A task authority specifies a positive revision, its absolute integration checkout, the canonical Axiom brief, the Axiom verification requirements mapped to brief criteria, protected repository-relative files, the expected verifier host identity, and the operator principal authorized to review completion. Include ignored files that affect a protected check in the protected file list. Check command sources are protected automatically. To change the brief, protected controls, reviewer or verification requirements, increment the authority revision and approve a new request.

1. Read the scoped Manager `task.delegate` intent and call `preview(requestId, sessionId)`. The approval binds the fingerprint returned for the exact intent, destination session, authority and source. Recheck that fingerprint with `admit(requestId, sessionId, fingerprint)` before staging. Only an `inserted` admission can start a new worker. Durable admission counts the brief’s attempts and concurrency limits across processes.
2. Stage an independent Git checkout with the exact approved source. Inside the worker executor's workspace preparation, call `verifyStaging(admissionId, workspace)`. Start the native worker only with an `inserted` staging confirmation and the admitted request. Record the exact native assignment with `recordLaunch`. Use `readAdmission(requestId)` to look up the durable assignment and known settlement. A reserved attempt whose launch is uncertain holds its slot.
3. Call `recordSettlement(admissionId, assignment, observation)` with the adapter's observed terminal result. Integrate the scoped changes in the trusted checkout and pass the retained native `workerRoot` to `inspectIntegration` with that receipt. The result comes from the staged workspace, preserves protected and out-of-scope files, and matches the integrated source snapshot. Keep worker Git configuration, ignored generated dependencies and credentials outside the trusted verification context.
4. From an isolated operator-controlled verification process, run `verify(admissionId)` to execute the approved checks through Axiom. Use a trusted environment and dependencies. The repository commands execute code, so invoke them only after reviewing the changes that will run. Verify the integrated source, review the settled result and submit their exact digests through the authorized operator boundary to `complete` along with the verification run. Axiom rechecks the archived observed evidence against the approved plan, verifier host, policy and current source. A result that is failed, blocked, stale or unrun leaves the task open.

`complete` returns the assessed checks and writes `task.completed` once when the mandatory criteria pass and the operator review still matches. It supports recovery through the durable journal and private Axiom archive. The Manager's MCP token can request delegation and report within its existing grant. The host's separate operator boundary owns approval and review. [MCP scope](mcp.md) · [Activity approvals](approvals.md)

## Verify the Linux flow

Build the workspace and run the installed Manager fixture with the pinned Hermes executable, built Axiom checkout, complete pinned Codex executable, and Chromium available to Playwright. The fixture uses disposable Git repositories, isolated runtime profiles and local scripted providers.

```sh
PRAXIS_RUN_EFFECTIVE_POLICY=1 \
PRAXIS_HERMES_BIN=/absolute/path/to/hermes \
PRAXIS_AXIOM_ROOT=/absolute/path/to/pinned-built-axiom \
PRAXIS_CODEX_BIN=/absolute/path/to/extracted-package/bin/codex \
node --test tests/runtime/hermes-manager-install.live.mjs
```

The fixture observes a native authenticated delegation intent, exact policy and brief delivery to Codex, a scoped edit, retained workspace and receipt identity, failed and stale command evidence, an unrun check, rejected verification-input changes and review without authority, and one conforming completion after the scoped edit is integrated and verified.
