<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

## `devenv` branch

The `devenv` branch is a standalone Pi 1.4.0 fork focused on a resizable fullscreen workflow,
embedded Neovim input, and clearer session/model presentation. Its changes live in Pi itself:
build and run it without `px`, tmux, ToolGuard, or other companion extensions. The entries
below describe **fork-specific behavior**, not claims that vanilla Pi lacks ordinary editing,
sessions, or models; the generic Getting started section further down installs upstream Pi, not
this branch. Optional `px` integrations such as Pair, subagents, browser tools, and Interaction
Tools are separate installations.

### Tool Index

#### Four-panel fullscreen layout

- **Summary:** Resize separate tool-output, conversation, input, and status regions.
- **Works with:** This `devenv` fork in fullscreen mode; the `four-panel` variant is not
  supplied by the pinned vanilla Pi host or VS Code Copilot.
- **Requires:** The built fork and `experimentalTuiLayout: "four-panel"` in Pi settings,
  followed by a Pi restart. No `px`, tmux, or Neovim is required to use the original input
  panel.

The standard layout remains the default. In four-panel mode, dividers allocate space between the
regions, and the input region can show the original editor, Neovim, or both. Wrapped transcript
text, mouse selection, and wheel scrolling remain usable within the fullscreen viewport.
**Setup:** [configure the layout](#configure-four-panel-fullscreen).

#### Embedded Neovim input

- **Summary:** Edit Pi prompts in a built-in Neovim viewport without changing Pi's command
  runtime.
- **Works with:** This fork's four-panel fullscreen layout; not an installable feature of
  vanilla Pi or VS Code Copilot.
- **Requires:** The built fork, four-panel mode, and `nvim` on `PATH`. No `px` checkout,
  external Pi Neovim module, or tmux; modified-key shortcuts additionally depend on terminal key
  reporting.

`/input orig|nvim|both` selects the visible input panels. Drafts synchronize, and persistent
sessions restore draft, cursor/mode, and panel visibility. Submitting through Neovim uses Pi's
normal input path, including slash commands; the original editor still works if you do not use
Neovim. **Setup:** [use embedded Neovim](#use-embedded-neovim-input).

#### Input, paste, and selection refinements

- **Summary:** Improve large pastes, wrapped-text copying, scrolling, and fullscreen input
  shortcuts.
- **Works with:** Interactive use of this fork; most selection refinements apply in fullscreen.
  Vanilla Pi has its own baseline input behavior.
- **Requires:** The built fork. `super+escape` and `super+/` require a terminal that reports
  Super; tmux is optional and may need extended-key setup for modified keys. Neovim-specific
  submission requires the Neovim viewport.

The fork delays conversion of large multiline pastes into attachments, preserves logical lines
when copying wrapped text, and supports mouse-wheel navigation. `super+escape` interrupts Pi
from either fullscreen input; `alt+/` provides an input-panel toggle inside tmux where Super may
be lost. Meta-Enter submits the embedded Neovim draft when connected. **Setup:**
[configure input and terminal keys](#configure-input-and-output-controls).

#### Model and session presentation

- **Summary:** Show readable model names and start the resume picker on named sessions.
- **Works with:** This fork's interactive UI; it does not require `px` or change vanilla Pi's
  model IDs or session storage format.
- **Requires:** The built fork; configured models for model selection. No Neovim or tmux.

The selector and footer prefer model display names and fall back to IDs, while configuration
continues to use model IDs. `pi -r` starts with named sessions; `/resume` starts with all
sessions. Queued steering messages remain visible. **Setup:**
[use the model and session UI](#use-model-and-session-presentation).

#### `/border` session color

- **Summary:** Set or reset the fullscreen frame color per Pi session.
- **Works with:** This fork's fullscreen UI. Separately installed child-session tools can
  inherit the color, but are not required.
- **Requires:** The built fork in fullscreen mode and a terminal capable of displaying the
  chosen color. No `px`, Neovim, or tmux for the parent session.

`/border #RRGGBB` sets the frame, `/border default` restores the theme default, and bare
`/border` reports it. The choice persists with the session; a separately installed subagent
launcher may pass it to children. **Setup:** [use `/border`](#use-border).

#### `/cl` visible-output clear

- **Summary:** Clear the rendered conversation and tool-output panels without deleting session
  history.
- **Works with:** This fork's interactive UI, in standard or fullscreen layout. No `px`
  dependency.
- **Requires:** The built fork; wait until streaming, compaction, or Bash has finished. Neovim
  is only needed for the optional `:PiClear` route.

`/cl` is a visual reset, not `/new` or a history erase. In embedded Neovim, `:PiClear` submits
it only when the buffer is empty, and the Neovim `/cl` command-line mapping works only while
connected to Pi. **Setup:** [use `/cl`](#use-cl).

### Install Details

#### Install the `devenv` fork

Install from source with Git, Node.js 22.19 or newer, and npm. The build does not require `px`,
`jq`, tmux, or Neovim:

```bash
git clone --branch devenv --single-branch git@github.com:b-soder/pi.git ~/src/pi-devenv
cd ~/src/pi-devenv
npm ci --ignore-scripts
npm run build
cd packages/coding-agent
npm link
```

`npm run build` refreshes model data and may need network access. `npm link` changes which
checkout supplies your global `pi` command; inspect an existing installation before linking.
Rebuild after later branch updates. Check `pi --version` and the chosen checkout before assuming
the installed CLI uses this fork. Neither the build nor link installs `px`, native approval
popups, provider credentials, or recipient-specific settings.

#### Configure four-panel fullscreen

Pi defaults to fullscreen mode with the standard layout. Use `/settings` to select the
experimental four-panel layout, or merge this setting into your own `~/.pi/agent/settings.json`
without replacing other keys:

```json
{
  "experimentalTuiLayout": "four-panel"
}
```

Restart Pi after changing the layout. Use the divider controls to resize the regions. To return
to the standard layout, select `standard` in `/settings` and restart. See the
[settings reference](packages/coding-agent/docs/settings.md#terminal-and-display).

#### Use embedded Neovim input

Install `nvim` separately and confirm it is on `PATH`; the Pi coding-agent package already
contains its RPC bridge. Four-panel sessions start with the original editor visible. Use
`/input nvim` or `/input both` to show Neovim, and `/input orig` to return. The short aliases
are `n`/`vi`, `b`, and `o`. Neovim stays alive when hidden, and a persistent session saves
the focused draft and mode. You do **not** need an external `px` Neovim Stow module or
`externalEditor: "nvim"` for this embedded viewport. See the
[settings reference](packages/coding-agent/docs/settings.md#terminal-and-display).

#### Configure input and output controls

The fork's paste threshold, wrap-aware copying, mouse selection, and scrolling need no extra
package. Keyboard shortcuts do depend on the terminal path: `super+/` toggles the Neovim input
panel outside tmux; inside tmux the fork also binds `alt+/`. `super+escape` interrupts from
either fullscreen input if Super reaches Pi. In embedded Neovim, Command-Enter or the tmux
Meta-Enter fallback submits when connected; ordinary Neovim behavior remains outside Pi. Use
`/hotkeys` to inspect active bindings. If modified keys are lost in tmux, consult
[tmux setup](packages/coding-agent/docs/tmux.md) and
[terminal setup](packages/coding-agent/docs/terminal-setup.md); tmux settings are for key
forwarding, not a prerequisite for the fork's layout. The `/settings` warning acknowledgement
suppresses Pi's tmux format advisory without changing tmux configuration.

#### Use model and session presentation

No additional package or setting is needed. Configure/authenticate any model using Pi's normal
provider flow; model selection still stores model IDs, not display names. Name a session with
`/name`; `pi -r` opens a named-only picker and `Ctrl+N` shows unnamed sessions, while `/resume`
shows all sessions by default. See
[session and context documentation](packages/coding-agent/docs/sessions.md).

#### Use `/border`

In fullscreen Pi, enter `/border #RRGGBB`, `/border default`, or bare `/border` to inspect the
current color. It persists for the session. Child inheritance is relevant only if you later
install a subagent integration; no separate component is required for the parent's border. See
the [settings reference](packages/coding-agent/docs/settings.md#terminal-and-display).

#### Use `/cl`

Run `/cl` after a turn to clear only visible output; the session file remains intact. It refuses
while Pi is streaming, compacting, or running Bash. When embedded Neovim is connected,
`:PiClear` works only with an empty draft and its `/cl` command-line mapping is
connection-scoped. No Neovim installation is needed for the ordinary `/cl` command.

To verify the fork without a model call, start a new interactive Pi session and inspect
`/settings`, `/input`, `/border`, and `/cl`. Installing a different Pi version or removing
the `experimentalTuiLayout` setting changes the UI; it does not require deleting stored sessions
or installing `px`.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md). Bundle them as [Pi packages](packages/coding-agent/docs/packages.md) and share via npm or git.

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

Use Pi [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [Pi TypeScript SDK](packages/coding-agent/docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

The installer pins all dependencies and updates Pi with `pi update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Pi does not require dependency lifecycle scripts for a normal npm installation.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](https://pi.dev/docs/latest) for full setup and usage instructions, or [visit pi.dev](https://pi.dev) for demos.

## Run with Nix

```bash
nix run github:earendil-works/pi/stable
```

`stable` points at the latest release. Install it with `nix profile add github:earendil-works/pi/stable` and update with `nix profile upgrade pi`. Use a release tag such as `github:earendil-works/pi/v1.0.0` to pin a version, or `github:earendil-works/pi` for unreleased changes on `main`. Nix builds Pi from source.

Supports ARM64 and x86-64 on Linux and macOS. Use `nix build .` or `nix run .` to build or run your checkout.

Nix builds are offline, so the bundled model data comes from a pi.dev model catalog revision pinned in `nix/model-catalog.json`. At runtime, Pi still overlays newer catalog data from pi.dev as usual. The Nix workflow replaces the pin on `main` when it no longer matches the checkout, for example after a provider is added or gains a new model type. To refresh it by hand:

```bash
npm run update:model-catalog-pin
```

## Packages

This monorepo contains the Pi CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Typed host runtime for hot-reloadable plugins, contracts, replicated state, and RPC over JSON links |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Local release smoke tests and npm publication use the same tarball packer; npm publishes the validated tarballs rather than repacking workspace directories.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
