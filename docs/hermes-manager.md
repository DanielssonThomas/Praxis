# Install the Praxis Hermes manager

The installer supports Linux x64 with Hermes Agent 0.23.3. The native setup was tested with Hermes source `caafe5389ae585ef77387a962aee05b1bcf17029`. The default manager uses the canonical Axiom core and its six skills from the governing Axiom revision `96014e73ca14111be83c448898e41559f0f87f88`. Optional Axiom profiles, other Hermes versions, other platforms, and release packaging require separate validation.

## Install

Build Praxis with `npm ci` and `npm run build`. Build your trusted, clean checkout of [the pinned Axiom source](https://github.com/DanielssonThomas/Axiom/tree/96014e73ca14111be83c448898e41559f0f87f88) with `pnpm install --frozen-lockfile` and `pnpm build`. The installer assembles the default native artifact with Axiom's own assembler and verifies its pinned digest.

```sh
node scripts/install-hermes-manager.mjs \
  --hermes-bin /absolute/path/to/hermes \
  --hermes-home /absolute/path/to/dedicated-praxis-hermes \
  --axiom-root /absolute/path/to/built-axiom
```

Select an empty dedicated root or one previously initialized by this installer. The dedicated root has its own profiles and account state. The installer reads the manager profile name from [portable settings](settings.md). The default is `praxis-manager`. Use lowercase letters and digits separated by single hyphens in its name. Pass `--mcp-origin http://127.0.0.1:PORT/mcp` if Praxis MCP listens on a different local port.

The installed profile's `SOUL.md` and native configuration are independently editable. Reinstalls preserve existing edits and the existing Praxis MCP entry. A failed seed leaves the profile unmarked. Restore the seed from [the manager template](../scripts/hermes-manager-soul.md) before retrying or select a fresh profile name. To replace a previously managed Axiom artifact with the pinned one, rerun with `--update`. Axiom enablement follows the selected profile's existing lifecycle configuration on updates. An enabled and installed bundle can be observed separately from loaded policy in a real native turn.

With `policy.axiomEnabled` disabled, the installer skips Axiom assembly and lifecycle changes and reports `preserved`. Use Axiom's native lifecycle to disable an already installed copy. The installer supports the default core selection. Configure optional architecture profiles through Axiom.

## Connect the installed profile

1. Run the [local Praxis MCP service](mcp.md) with a scoped manager grant. Put that grant's bearer in the named Hermes profile's `.env` as `PRAXIS_MCP_TOKEN`. The installed MCP configuration references the variable. Its value stays local to the profile.
2. Configure the model and its credential in the selected native profile. Set that profile's `API_SERVER_KEY` in its own `.env`. Choose a separate strong local API bearer for the default gateway.
3. Start the native gateway from its explicit default profile under the dedicated root. Set `HERMES_HOME` to the installed root, `API_SERVER_ENABLED=true`, `API_SERVER_HOST=127.0.0.1`, `API_SERVER_PORT` to the chosen local port, and `API_SERVER_KEY` to the default gateway's bearer. Run `hermes -p default gateway run`.
4. Set `PRAXIS_HERMES_ORIGIN` to the named gateway URL, such as `http://127.0.0.1:8642/p/praxis-manager`. Set `PRAXIS_HERMES_API_KEY` to the named profile's bearer. [Hermes connection details](hermes-runtime.md)

The [foreground manager endpoint](manager-foreground.md) uses this named connection.

## Verify the setup

With a built checkout of Praxis, use Chromium, the pinned Hermes source executable and the pinned built Axiom checkout for the following native smoke test. Set `PRAXIS_TEST_CHROMIUM` to use an installed system browser. The fixture creates disposable user and Hermes roots and uses a scripted localhost provider.

```sh
PRAXIS_HERMES_BIN=/absolute/path/to/hermes \
PRAXIS_AXIOM_ROOT=/absolute/path/to/built-axiom \
node --test tests/runtime/hermes-manager-install.live.mjs
```

It checks initial installation, reinstall, explicit bundle replacement, preservation of local files, exact Axiom core and skill discovery in a real native request, all four Praxis MCP tool schemas, and authenticated task inspection.
