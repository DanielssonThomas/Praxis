# Praxis v1 architecture

## Runtime and desktop target

Praxis uses Node.js 24 and TypeScript for its local application, npm workspaces to share packages, and a locked dependency graph. Start with a browser desktop surface served by a local Node process. Browser-native HTML, CSS and TypeScript are sufficient for the application shell. Package the local host and UI together for v1 setup, targeting Linux first for verification. Release packaging and other OS support depend on the evidence in [#24](https://github.com/DanielssonThomas/Praxis/issues/24).

The local host listens on loopback and owns credentials and operational storage outside the browser. The browser renders local state and sends requests to that host. Hermes runs separately and owns orchestration, dispatch and native session lifecycles. The [Hermes runtime adapter](hermes-runtime.md) maps native run identifiers and capabilities into Praxis session snapshots. Closing Praxis leaves Hermes work running.

## Shared contracts

`@praxis/contracts` is the canonical owner of Praxis task, session, event, action, approval and usage record identities. All records carry an explicit schema version. Record kinds use distinct ID prefixes with opaque, case-sensitive suffixes. References use the same parsers as the records they identify. Adapter IDs stay external and are mapped to stable Praxis IDs by the owning integration. Runtime schemas validate record shape and typed references. Storage and service owners verify that referenced records exist and that actions are authorized.

The contracts cover Praxis operational records. Axiom owns task briefs, effective-policy identity, capability and host identity, evidence, and benchmark results. Those contracts apply at the Axiom integration boundary in [#23](https://github.com/DanielssonThomas/Praxis/issues/23). The pinned Axiom contracts package is a private, unpublished workspace package. Use its documented interfaces at that boundary and reuse the package through an authorized distribution when available. See [the upstream contract inventory](https://github.com/DanielssonThomas/Axiom/blob/96014e73ca14111be83c448898e41559f0f87f88/docs/architecture.md#workspace-contracts).

| Area | Owner |
| --- | --- |
| Record identity, versioning and runtime snapshots | Shared contracts package |
| Native execution and identifiers | [Hermes runtime](hermes-runtime.md) and [direct Codex worker](codex-worker.md) adapters |
| Native task projection and provider issue links | [Kanban](kanban.md) |
| Local persistence, references and event replay | [Local state store](operational-state.md) |
| Agent coordination and scoped request intake | [Praxis MCP](mcp.md) |
| Approval semantics and execution authorization | [Approval and execution services](approvals.md) |
| Measured usage and reporting policy | Native adapters and reporting service |

See the [Hermes feasibility review](hermes-feasibility.md) for the native surfaces under consideration and their verification requirements.
