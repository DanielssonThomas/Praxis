# Application shell

Build and run `npm start`, then open the printed loopback address. Open the menu or run a command to switch between Manager, Overview, Kanban and Settings. The command bar remains available across views. Returning to a view restores its unsubmitted command draft. Browser history also switches between the mounted views.

| Command | Shortcut | Result |
| --- | --- | --- |
| `/manager` | `/m` | Open Manager |
| `/overview` | `/o` | Open Overview |
| `/kanban` | `/k` | Open the native board view |
| `/settings` | `/s` | Open the local settings editor |
| `/help` | `/h` | List the commands |

Command lookup and feedback run in the browser. Manager conversation and session data are tracked in [#8](https://github.com/DanielssonThomas/Praxis/issues/8) and [#9](https://github.com/DanielssonThomas/Praxis/issues/9).

When configured, **Activity** opens the operator review panel and keeps the same cards visible as you switch views. See [scoped approvals](approvals.md) for setup.

See [Kanban setup](kanban.md) to connect a local Hermes board and verify GitHub issue links.

Run browser checks against the built application with `npm run build`, `npm exec -- playwright install chromium` and `npm run test:browser`. Set `PRAXIS_TEST_CHROMIUM` to use a local Chromium executable. CI installs the locked Playwright Chromium on a hosted Ubuntu runner.
