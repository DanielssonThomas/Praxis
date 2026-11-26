# Praxis v1 architecture

## Runtime and desktop target

Praxis v1 ships an Angular application in a Tauri desktop window, targeting Linux x64 first. The [desktop development guide](desktop.md) covers the Angular workspace, atomic UI composition and production bundle. Tauri owns desktop startup, local host supervision and the native IPC boundary. Release readiness and platform coverage follow verified evidence in [#24](https://github.com/DanielssonThomas/Praxis/issues/24).

The existing Node.js 24 host listens on loopback and owns credentials, execution authority and operational storage. Angular renders local state and uses the desktop bridge to request host operations. Hermes runs separately and owns orchestration, dispatch and native session lifecycles. The [Hermes runtime adapter](hermes-runtime.md) maps native run identifiers and capabilities into Praxis session snapshots. Closing Praxis leaves independently running Hermes work active.

## Shared contracts

`@praxis/contracts` is the canonical owner of Praxis task, session, event, action, approval and usage record identities. All records carry an explicit schema version. Record kinds use distinct ID prefixes with opaque, case-sensitive suffixes. References use the same parsers as the records they identify. Adapter IDs stay external and are mapped to stable Praxis IDs by the owning integration. Runtime schemas validate record shape and typed references. Storage and service owners verify that referenced records exist and that actions are authorized.

The contracts cover Praxis operational records. Axiom owns task briefs, effective-policy identity, capability and host identity, evidence, and benchmark results. Those contracts apply at the Axiom integration boundary in [#23](https://github.com/DanielssonThomas/Praxis/issues/23). The pinned Axiom contracts package is a private, unpublished workspace package. Use its documented interfaces at that boundary and reuse the package through an authorized distribution when available. See [the upstream contract inventory](https://github.com/DanielssonThomas/Axiom/blob/96014e73ca14111be83c448898e41559f0f87f88/docs/architecture.md#workspace-contracts).

| Area | Owner |
| --- | --- |
| Record identity, versioning and runtime snapshots | Shared contracts package |
| Native execution and identifiers | Hermes and its Praxis adapter |
| Native task projection and provider issue links | [Kanban](kanban.md) |
| Local persistence, references and event replay | [Local state store](operational-state.md) |
| Agent coordination and scoped request intake | [Praxis MCP](mcp.md) |
| Approval semantics and execution authorization | [Approval and execution services](approvals.md) |
| Measured usage and reporting policy | Native adapters and reporting service |

See the [Hermes feasibility review](hermes-feasibility.md) for the native surfaces under consideration and their verification requirements.
