# Praxis desktop development

Use Node.js 24.22.3 from [`.node-version`](../.node-version) and its bundled npm 11.19.1. The npm lockfile pins Angular 21.2.26, Angular CLI and builder 21.2.31, TypeScript 5.9.3 and Playwright 1.65.1.

```sh
npm ci
npm run start:desktop
npm run build:desktop
npm run check:desktop-composition
npm exec -- playwright install chromium
npm run test:desktop
```

The Angular CLI handles the single frontend application in the existing npm workspace. The current build and CI have no project orchestration requirement that needs Nx. The production build writes the web assets for Tauri to `apps/desktop/dist/browser`. The app uses hash-based Angular routing so the same bundled entry point serves every route.

`apps/desktop/src/app/shell` owns bootstrap composition, routes and the permanent command bar. Domain views expose an entry point in `features/<domain>/index.ts`; keep components and services that serve only that domain inside it. Use `*.model.ts` for named frontend models and colocate a page's component, template, styles and related checks. The shared UI directory owns reusable primitives. The menu and command bar use the same accessible native button atom.

Follow Axiom's pinned [Atomic UI profile](https://github.com/DanielssonThomas/Axiom/blob/96014e73ca14111be83c448898e41559f0f87f88/profiles/ui-atomic/PROFILE.md). Components import strictly lower layers in the atom, molecule, organism and template hierarchy. The composition check reads the TypeScript dependencies and verifies layer direction, feature entry points and colocated component resources. The shell browser suite exercises the built output at 1280 × 800 and 360 × 620 for layout, keyboard focus, command feedback and draft restoration. Set `PRAXIS_UI_EVIDENCE_DIR` to retain Playwright traces. CI uploads them from the Angular desktop shell job.

For the existing Node host's browser surface and integration commands, see [application shell](shell.md).

## Linux x64 native development package

Install the [Tauri Linux build dependencies](https://v2.tauri.app/start/prerequisites/#linux), including WebKitGTK 4.1, GTK 3, a C compiler and pkg-config. Use Rust 1.100.0 with rustfmt and Clippy, selected by `apps/desktop/src-tauri/rust-toolchain.toml`. Install the official Linux x64 Node.js archive for the pinned version and add its `bin` directory to your path. The packaging script copies that runtime and the archive's `LICENSE` into the development package.

```sh
npm ci
npm run package:desktop
```

The npm lockfile pins the Tauri CLI and frontend API. Cargo.lock pins the Rust dependencies. The package command builds both the Angular app and the existing host, stages the host's locked production dependencies, and produces the amd64 development `.deb` under `apps/desktop/src-tauri/target/debug/bundle/deb` unless Cargo's target directory is overridden. The desktop launcher opens the bundled Angular app in one window. Tauri starts the packaged Node host on an operating-system-selected loopback port and the window reports startup failure and exposes retry. The local host still owns credentials, authorization and operational storage. Closing Praxis releases the process it launched. Hermes remains independently managed.

## Native validation

```sh
npm run build:desktop
npm run check:desktop-rust
cd apps/desktop/src-tauri
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
```

Keep `main.rs` focused on starting the executable and `lib.rs` on composing the app. Commands acquire managed resources and delegate work. Services own process and network operations, and state owns managed resources and synchronization. Keep handwritten Rust files around 400 lines and below 500 by default. Document any exception in the owning module and validation report. The workspace check verifies line counts, keeps direct infrastructure imports out of entry points and commands, and keeps Tauri imports out of services and state.

The packaged lifecycle smoke uses `WebKitWebDriver` from the distribution's WebKitGTK package, Xvfb, Xauth, Openbox, xdotool, `ss` from iproute2, and the pinned [Hermes runtime](hermes-manager.md). Run it from the repository root. Provide absolute paths to the development package and to the test Hermes executable. The test extracts the package to a disposable directory, uses a scripted loopback provider for an independent real Hermes run, and verifies that work continues across native app closure and reopen.

```sh
PRAXIS_DESKTOP_DEB=/absolute/path/to/Praxis_0.1.0_amd64.deb \
PRAXIS_HERMES_BIN=/absolute/path/to/hermes \
GDK_BACKEND=x11 xvfb-run -a -s '-screen 0 1280x800x24' dbus-run-session -- \
  sh -c 'openbox >/dev/null 2>&1 & npm run test:desktop:live'
```

Set `PRAXIS_DESKTOP_EVIDENCE_DIR` to capture failure and recovery screenshots.

## Desktop IPC

Rust owns the Serde wire models and Tauri command signatures. Register commands in `src-tauri/src/commands/mod.rs` so Tauri Specta derives invocation and TypeScript bindings from the same list. Keep the window permissions in `src-tauri/capabilities/main.json` scoped to the registered commands that the shell uses. Angular components use the dedicated bridge in `src/app/native`.

```sh
npm run build:desktop
npm run generate:desktop-ipc
npm run check:desktop-ipc
npm run test:desktop-ipc-drift
```

Generation writes `apps/desktop/src/generated/desktop-ipc.ts`. Check in that output with the Rust change. The check generates into a temporary directory, compares the result with the checked-in file and exits with an error on drift. The drift regression changes a temporary copy and verifies the same comparison rejects it. CI runs both checks on Linux.

The readiness command queries the supervised Node host and returns the running Node version when it is ready. Starting returns a null version and a bounded retry interval in milliseconds. The ready reply omits the retry interval. The Rust interval is a `u16`, which JavaScript represents exactly. Errors use stable codes and redacted messages. The native smoke verifies the displayed state against the running sidecar version.
