# Application shell

Build and run `npm start`, then open the printed loopback address. Open the menu or run a command to switch between Manager, Overview and Settings. The command bar remains available across views. Returning to a view restores its unsubmitted command draft. Browser history also switches between the mounted views.

| Command | Shortcut | Result |
| --- | --- | --- |
| `/manager` | `/m` | Open Manager |
| `/overview` | `/o` | Open Overview |
| `/settings` | `/s` | Open the local settings editor |
| `/help` | `/h` | List the commands |

Command lookup and feedback run in the browser. Manager conversation and session data are tracked in [#8](https://github.com/DanielssonThomas/Praxis/issues/8) and [#9](https://github.com/DanielssonThomas/Praxis/issues/9).

Run browser checks against the built application with `npm run build`, `npm exec -- playwright install chromium` and `npm run test:browser`. Set `PRAXIS_TEST_CHROMIUM` to use a local Chromium executable. CI installs Chromium and its Linux dependencies on a fresh runner.
