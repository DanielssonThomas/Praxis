# Praxis v1.0.0 for Linux x64

Praxis opens the Angular desktop in one Tauri window and starts its bundled Node.js host on loopback. Use **Setup** from the menu, or enter `/setup`, to check the local host, connect the default Manager and configure operator access.

## Install

Use a Debian-based Linux x64 system and install Git and Hermes Agent 0.23.3. The tested operating system is Ubuntu 26.04.1 x64. Download `Praxis_1.0.0_amd64.deb` and its `SHA256SUMS` into the same directory. [Praxis release](https://github.com/DanielssonThomas/Praxis/releases/tag/v1.0.0) · [Pinned Hermes Agent](https://github.com/NousResearch/hermes-agent/releases/tag/v0.23.3)

```sh
sha256sum -c SHA256SUMS
sudo apt install ./Praxis_1.0.0_amd64.deb
```

From the separate Axiom release, download the Linux x64 archives and their checksum file into a different directory. Verify the downloads there and extract the built runtime. Praxis expects this intact directory at the absolute `--axiom-root` path. [Axiom v1.0.0](https://github.com/DanielssonThomas/Axiom/releases/tag/v1.0.0)

```sh
sha256sum -c SHA256SUMS
tar -xf axiom-v1.0.0-runtime-linux-x64.tar.gz
```

Run the installer as your ordinary desktop user. Choose an empty dedicated Hermes root and the absolute paths to the pinned Hermes executable and extracted Axiom runtime.

```sh
/usr/lib/Praxis/host/bin/node /usr/lib/Praxis/host/setup/install-hermes-manager.mjs \
  --hermes-bin /absolute/path/to/hermes \
  --hermes-home /absolute/path/to/dedicated-praxis-hermes \
  --axiom-root /absolute/path/to/axiom-runtime
```

The installer creates the default `praxis-manager` profile, configures its local MCP entry and activates Axiom core v1 with all six skills. The qualified release source is `ef35e6f5fb881db878a9547f124f8c28a08b414e`. The installer checks the Hermes bundle digest against the upstream qualification. Source builds and a system Node.js installation are unnecessary for this path. [Axiom release evidence](https://github.com/DanielssonThomas/Axiom/issues/20)

## Connect the Manager

Configure Hermes's model login and the scoped Praxis MCP grant. Keep the provider credential in Hermes and the MCP bearer in the profile's private environment file. Start the installed MCP service with your local authority file. [Connect the named profile](hermes-manager.md#connect-the-installed-profile)

```sh
PRAXIS_MCP_CONFIG_FILE=/absolute/path/to/authority.json \
  /usr/lib/Praxis/host/bin/node /usr/lib/Praxis/host/node_modules/@praxis/mcp/dist/cli.js
```

Start the Hermes gateway under the dedicated root with `/usr/lib/Praxis/host/bin` on its `PATH`. Set `PRAXIS_MCP_CONFIG_FILE` in the Praxis launch environment to the same authority file. Configure the named profile URL and bearer using `PRAXIS_HERMES_ORIGIN` and `PRAXIS_HERMES_API_KEY`. Use the extracted runtime directory for `PRAXIS_AXIOM_ROOT` when enabling the local skill validator or for the `axiomRoot` setting in Codex delegation configuration. [Hermes connection](hermes-runtime.md) · [Codex worker configuration](codex-worker.md)

Set `PRAXIS_OPERATOR_TOKEN_DIGEST` to the SHA-256 hex digest of a separate operator token. Reopen Praxis and enter the original token in Manager. Missing or stopped local host resources appear in the desktop window with a retry action. [Operator access](manager-foreground.md)

## Upgrade

Close the desktop and use `apt install` with the new versioned package. Package-managed application files are separate from portable settings and the operational database. Preserve the existing settings directory, database, named Hermes root and authority file. If your existing Praxis profile used the development Axiom bundle, rerun the bundled installer with `--update` and the v1 runtime path before reopening the Manager. The update preserves the profile's existing selection and unrelated configuration. [Manager lifecycle](hermes-manager.md#install)

## Verified configuration

The release target is Ubuntu 26.04.1 x64, WebKitGTK 2.52.6, Wry 0.57.4, Tauri 2.12.7, Angular 21.2.26, bundled Node.js 24.22.3, and Hermes Agent 0.23.3 at `caafe5389ae585ef77387a962aee05b1bcf17029`. Direct native delegation uses Codex CLI 0.172.0-alpha.2. The Axiom configuration uses the default core without optional profiles. Other operating systems, CPU architectures and runtime versions need separate qualification. Release acceptance records the exact source, artifact checksum, package-manager results and runtime surfaces. [Release acceptance](https://github.com/DanielssonThomas/Praxis/issues/24)

## Build the release package

Build on Linux x64 with the workspace's pinned Node.js release, the Linux Tauri build dependencies and the locked Rust dependencies. This command selects the optimized Debian release bundle.

```sh
npm ci
npm run package:native --workspace @praxis/desktop -- --release
```

The package is under the Tauri Cargo target's `release/bundle/deb` directory. [Desktop build and validation](desktop.md)
