# Session overview

Run `/overview` or `/o` from the Manager view to open up to ten registered sessions. Each pane shows the task title, ticket or Praxis task ID, observed status and the latest bounded native output. Expand a pane to see its available usage and session ID. Expanding another pane closes the previous one.

Overview uses the local [operator and Hermes configuration](approvals.md). Add the native `assignment` handle for each session to its grant in the [MCP authority file](mcp.md). The local store supplies the registered task and session identities. Credentials stay on the host.

Set `PRAXIS_OVERVIEW_MANAGER_PRINCIPAL_ID` to the configured manager principal from that same authority file. The most recent unresolved session-targeted activity from that principal highlights only its matching visible pane. The highlight clears when the activity resolves. The Activity panel and Overview read the same persisted event lifecycle.

Native output reads resume from the recent event sequence. Hermes can expire an unconsumed buffer. Overview reports unavailable output or an omitted prefix when the native stream cannot supply the full excerpt. An authoritative final receipt supplies available terminal output. Native usage is displayed when the run reports it.

When authorized Overview inspection observes reported usage for an exact settled run, Praxis saves the measurement once for local reporting. The expanded pane flags a persistence conflict or failure alongside the native result. [Local Reports](reports.md)

After building, set `PRAXIS_HERMES_BIN` and run `npm run test:overview:live`. The target fixture exercises the mounted Manager view, ten real Hermes runs, native output, the reported tokens chart, Chromium motion preferences and a configured manager principal submitting its action through native MCP. The full Manager conversation is tracked in [#8](https://github.com/DanielssonThomas/Praxis/issues/8).

## Manual session control

Overview starts in read-only mode. An operator can expand a running native session and choose **Take over** when the authority file enables `operatorCanTakeover` on its exact assignment. Keep the local operator credential separate from MCP principal credentials. The native Hermes bearer remains on the local Praxis host.

While manual control is active, the operator can send a bounded plain-text instruction through the native Hermes steer API. Hermes still owns model execution, tool permissions and any runtime approval. The shared Praxis store holds the exact session's scoped native mutations, including an otherwise approved `session.stop` request. Read-only inspection and other sessions remain available. The manager process can be offline.

Hermes acknowledges guidance before it can prove delivery. **Return control** waits for a matching user message after the recorded transcript baseline. A wrapped Hermes steer row confirms delivery at a tool boundary. A matching plain row in a terminal run confirms transcript recording. Praxis keeps control in manual mode until either proof is available. In the verified Hermes release, a delivered steer can become durable at the next transcript flush or at run completion. The pending state survives a Praxis host restart. Once confirmed, the ordinary scope and approval rules apply to the resumed session. Each new guidance submission waits for verification of the preceding one.

Praxis holds the automated fence when a native write might have been dispatched and no authoritative result is available. The approval claim and fence are stored together, and known settlements release the fence in the same transaction. A crash after claiming an action or losing the native response may leave the session fenced for this assignment. Read-only inspection remains available. Praxis reads back to the recorded transcript baseline across consistent native pages. If the receipt, assignment or page boundary is unverifiable, manual control stays active. The current automated write surface is a scoped session stop. Automatic text guidance remains a manager integration gap.

Build and run `npm run test:control:live` with `PRAXIS_HERMES_BIN` pointing at Hermes. Set `PRAXIS_TEST_CHROMIUM` if using a system Chromium. The fixture uses a real v0.23.3 worker, a real manager MCP request and an isolated loopback provider. It verifies that an early handback fails, the worker remains active through verified handback, and the ordinary approved stop then reaches the native worker.

## Native desktop Overview

In the packaged desktop, open **Overview** or run `/o`, then enter the local operator credential. The view reads registered sessions from the same Node host used by the browser shell. The native bridge keeps the verified credential in memory until you lock the view or close Praxis. Session output remains bounded and distinguishes an unavailable or truncated replay from live text. Expanding one worker collapses the previous one. Overview reconnects to independently running sessions after Praxis is reopened.

An approved [direct Codex assignment](codex-worker.md) appears on the same Overview pages. Its expanded details show the Codex run identity and any reported usage. The independent worker records the latest bounded observation so the window can reopen to the same run. Codex uses a read-only pane with its control availability shown explicitly.
