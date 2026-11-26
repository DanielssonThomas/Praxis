# Local reports

Build and start Praxis, then open **Reports** from the menu or run `/reports`. Set `PRAXIS_OPERATOR_TOKEN_DIGEST` to the SHA-256 digest of the local operator credential. When `PRAXIS_MCP_CONFIG_FILE` is configured, reports use its operational database. For a reports-only setup, set `PRAXIS_REPORTS_DATABASE` to the local SQLite file. Open the view with the operator credential. Charts and exports run locally and make no model calls.

The [packaged desktop](desktop.md) uses the same setup and projection. Enter the operator credential to unlock Reports. The native app keeps authorization in memory for that view and verifies requests through the local host. **Lock reports** ends the local Reports session. Export saves the selected UTC range and visible metrics into `praxis-report.json` in the system download directory.

Chart.js shows 7, 30 or 90 days up to the selected retention limit. Days use UTC. Hover over a point to see its date and value. Use **Report preferences** to select visible metrics and enable JSON export or history clearing. Export includes the visible metrics in the selected window. Pausing collection suspends the report projection. The operational audit continues and retained observations are available when reports resume. Clearing report history stores a cutoff and excludes previously dated observations from reports. The operational audit records remain intact.

| Chart | Local source |
| --- | --- |
| PRs opened, PRs merged and tickets completed | Typed `provider.pr_opened`, `provider.pr_merged` and `provider.ticket_completed` receipts. Each first occurrence is keyed by event kind, provider, normalized repository and work-item number. A stream with no receipts within retention is unavailable. Zero is the local recorded count for a day in a stream with receipts. |
| Average task duration | Minutes from the first `task.started` through the first paired `task.completed` per task. It is grouped by completion day. |
| Reported tokens and reported USD cost | `usage.observed` references to immutable usage records, counted once per usage ID. Token totals require both input and output values on the record. Costs use reported USD amounts. Unknown values are gaps, with explicitly measured zero retained. |
| Operator interventions | First human approve or deny `action.decision` per request. |

Opening an authorized Overview records available usage from settled Hermes runs. Reports groups those records by the UTC day of their first saved observation. Runs without an observed measurement leave gaps in the chart. The adapter currently reports input and output tokens when Hermes supplies them.

Native board issue links verify issue identity. Production PR and ticket-lifecycle ingestion still needs source integration. The deterministic Reports fixture and the live Overview fixture both use the same app and database as the running view.

## Verify the packaged views

Build the [Linux x64 development package](desktop.md) and point the native workflow at its absolute path. The fixture uses a disposable operational store, a generated operator credential and an existing portable settings file.

```sh
PRAXIS_DESKTOP_DEB=/absolute/path/to/Praxis_0.1.0_amd64.deb \
GDK_BACKEND=x11 xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- \
  npm run test:desktop:reports-settings
```

The smoke checks keyboard navigation and range filtering, actual chart drawing, export scope, measured zero, missing measurements, audit retention, settings validation and restart recovery. Set `PRAXIS_DESKTOP_EVIDENCE_DIR` to retain screenshots of the native workflows.
