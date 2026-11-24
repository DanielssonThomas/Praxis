# Praxis contributor instructions

Read the assigned issue, [README](README.md), and [architecture](docs/architecture.md) before editing.

## Governing policy

Use Axiom at revision `96014e73ca14111be83c448898e41559f0f87f88`. Consult the [core principles](https://github.com/DanielssonThomas/Axiom/blob/96014e73ca14111be83c448898e41559f0f87f88/core/AXIOMS.md) and [contributor rules](https://github.com/DanielssonThomas/Axiom/blob/96014e73ca14111be83c448898e41559f0f87f88/AGENTS.md) at that revision. Coordinate policy revision changes through the integration owner.

## Issue ownership and integration

- Implement one delivery issue per pull request. Epic descriptions organize linked issues and acceptance evidence.
- The integration owner confirms merged prerequisites and their evidence before setting `status: ready`. Claim a ready issue on GitHub with the owned paths, branch or worktree, acceptance criteria and validation, then remove `status: ready`. The claim owner or integration owner releases a claim explicitly.
- Keep an issue-specific branch or worktree based on merged prerequisites. Coordinate changes outside the claimed paths with the owner. The integration owner coordinates root manifests, the lockfile, shared contracts, central exports and release assembly.
- Merge when all required acceptance checks pass for the delivered source state. The integration owner checks the combined result and advances dependent issues.

## Evidence

- For executable behavior, demonstrate a failing test for the intended gap before implementing it. Record the outcome of that check and its passing regression run.
- Run the [workspace checks](README.md#development) and issue-specific validation. Runtime acceptance requires observations from the stated target, version, surface and OS. Protect credentials, configuration and session records in code, output and evidence.
- Map each acceptance criterion to evidence and the exact tested revision. Refresh affected evidence after changes. Report applicable failed, blocked and unrun checks as open acceptance gaps. Include artifacts and dependencies in the handoff.
