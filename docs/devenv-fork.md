---
title: The devenv Pi fork
description: Fork-only features, state, paired PX builds, deployment, and upstream maintenance.
status: Current
owner: Pi fork
last-reviewed: 2026-11-12
---

# The devenv Pi fork

## Purpose

This fork preserves upstream Pi's standalone agent harness and adds fullscreen UI/editor behavior, presentation APIs, shell guardrails, and selected Chord fixes. PX is a separate companion installation: Pair, subagents, ToolGuard, Questioner, Notifier, Intrapi, and observational memory are **not implemented by this fork**. Browser/web copies were removed from current PX; neither checkout supplies those optional external tools. Chord and Durable already existed upstream; they are not wholesale fork additions.

The reviewed fork snapshot is `c4b28cb3ee6ab6a18aec7be968c5fd5431d7d922`, branch `devenv`; locally recorded upstream base/merge-base is `085c84e98e7f4c950f2be606466fff4f75d8fe7c`. No network fetch was performed, so that is not necessarily today's remote tip. Final-tree fork inventory: 133 changed paths, 8,019 additions/384 deletions including tests/docs/locks. The old root README's 1.4 version label is stale against the **1.5.0 private candidate** compatibility ledger; neither label establishes global release acceptance or installed bundle identity.

## How it works: differences from upstream

### Interactive host and input

| Feature | Behavior and limits | Source |
| --- | --- | --- |
| Four-panel fullscreen | Separate tools, conversation, input, status; resizable separators, viewport scroll, selection/wrapped copy; standard layout remains available | `packages/tui/src/{tui-alt-screen,layout}.ts`, coding-agent `tui-renderer.ts`, `chat-viewport.ts`; `f291a3b01` |
| Supporting TUI geometry | Borderless editor cursor/mouse hit testing, boxes/stacks/mouse regions, wrap tracking and selection | `packages/tui/src/components/{editor,markdown,text}.ts`; `616c039e8`, `c22828833` |
| Paste markers | Stored marker only when pasted text is strictly greater than 100 lines or 10,000 characters, rather than upstream 10/1,000 | TUI `editor.ts`; `4452c3d8a` |
| Embedded Neovim | Four-panel-only packaged Lua RPC/UI bridge; `/input` selects original/editor/both, default original; editor stays alive when hidden, submits through ordinary Pi command/message path | coding-agent `components/neovim-viewport.ts`, `src/modes/interactive/assets/pi-embedded-nvim.lua`; `ec37bde1d`, `901eda0c1` |
| Neovim synchronization | 120 ms draft debounce, cursor/mode/focus/paste/copy synchronization; `:PiFlush` submits/clears; `:PiQuit` transfers draft/quits; connected `:q`/`:q!` map to PiQuit | Bridge and viewport; `20829b2b2`, `296593fd1`, `b457df43f`, `62af54fe0` |
| Input bindings | Configurable `app.input.toggle` Super+/ (Alt+/ inside tmux), `app.input.interrupt` Super+Escape; Meta/Command-Enter depends on terminal key reporting | `core/keybindings.ts`; `f67d35786`, `45a921c39` |
| Visible clear | `/cl` clears rendered chat/tools, not saved session; refuses during streaming, compaction, or Bash. Neovim `:PiClear` requires empty buffer | interactive mode/bridge; `eabce60ee` |
| Message dividers | Local date/time with dark-blue theme token; restored messages retain original timestamp, narrow panes clip | `components/message-timestamp.ts`; `97b768223` |
| Custom-output routes | `px-interaction`, `subagent_status`, `subagent_result`, `px:intrapi-durable-message`, `px:intrapi-coordinator-ping-hint` render in tools panel; Questioner remains chat; standard layout unchanged | `interactive-mode.ts`; `a0f2224e8`, `d72925275` |

### Session, model, and extension presentation

| Feature | Behavior and limits | Source |
| --- | --- | --- |
| Name-first model display | Selector/footer prefer name, fall back to ID; configuration uses exact IDs | model selector/footer; `803c5e39a` |
| Named resume filter | `pi -r` initially named-only; `/resume` initially all; Ctrl+N toggles | CLI/session selectors; `95d9a4085` |
| Queued steering display | Pending steering remains visible | `97734e053` |
| Session border | `/border #RRGGBB`, `/border default`, bare report; persisted session frame color, optional child handoff | border/input-state/session-manager; `854070faa`, `cf410644f` |
| Model-colored border | Exact global provider/model mapping on startup/switch overrides manual border; absent match preserves current color | `border-color.ts`, interactive mode; `bd1892a9a` |
| Divider extension API | Optional `ctx.ui.setDividerStatus(key, text or undefined)` adds keyed right-side status; feature-detect on stock hosts; custom editors may not render it | extension types/custom editor/status components; `61bc4b406` |
| Command argument hints | Optional registered-command `argumentHint` reaches slash completion and RPC descriptors; display metadata, not validation | extension types, agent-session, slash commands, interactive/RPC modes; `c4b28cb3e` |

### Shell, Chord, dependencies, and tests

- Coding-agent Bash/shell timeout is optional **seconds**, with no default; finite, strictly positive, <=86,400, validated before spawn. Oversized values include a seconds-versus-milliseconds diagnostic. Rendering uses minutes for exact minute multiples and seconds otherwise (`a4f436314`, `a238d8aee`; `core/tools/bash.ts`, `core/tools/renderers/bash.ts`). Durable shell descriptions clarify units separately; do not assume the coding-agent maximum applies there.
- Chord oversized WebSocket frames preserve their close code (`235306465`, `packages/chord/src/node/http/upgrades.ts`); sandbox permission paths are canonicalized (`031d00890`, `node/tui/sandbox.ts`).
- Chord plugin watcher convergence and native mark attribution address delayed macOS setup (`58fe65a24`). Readiness tests use real native-event barriers (`02cfa588c`). Finite post-registration reconciliation (`0cb67da5f`, merge `e3f0f975d`) watches directory trees/external plugin roots, ignores `.git`/`node_modules`, does not follow symlinks, and coalesces native marks by generation. Sweeps at 0/250/1,000/3,000 ms have a 100,000 cap and yield after 256 generator steps for 10 ms. This is bounded best effort, not permanent polling or lossless events. Scan errors skip reconciliation while native watch remains; native watcher failure reports once, stops watches, and builds occur on demand. There is no new public setting. See [native reconciliation](../packages/chord/docs/native-watch-reconciliation.md) and [readiness](../packages/chord/docs/native-watch-readiness.md).
- Root npm override adds `brace-expansion: 5.0.12` with reviewed root/installer locks (`eb8c74b94`). Existing `protobufjs` override is upstream baseline, not a custom feature. Do not infer an undocumented advisory from the security commit subject.
- Test-only fork maintenance covers canonical macOS fixture paths/paste, asset isolation/native teardown, app-lock budgets, Darwin sandbox/PTY relay, snapshot paths, deterministic file order/time, cancellation race, and catalog-independent provider checks (`332532ab7`, `dad610ce2`, `91240f88d`, `330316948`, `dbd210741`, `72bb99659`, `a44528107`, `b0183603f`, `abb748cb0`, `e031153a9`, `db1186e84`). These are fixture/portability corrections, not new user features.
- Settings/keybinding/theme schemas, regression tests, and install-lock/assets support these differences. Prior merges `3cb1f7009` and `4d3006f84` retained upstream metadata and fork UI. Merge-reachable history is not uniquely fork-authored net change.

Reproduce the complete changed-path inventory read-only:

```bash
git diff --name-only 085c84e98e7f4c950f2be606466fff4f75d8fe7c..devenv
```

## Usage and commands

In four-panel sessions:

```text
/settings                  choose layout (restart required)
/input orig|nvim|both       aliases o, n/vi, b
/border #336699             session fullscreen frame
/border default            reset
/cl                        visible output only
/resume                    all sessions initially; Ctrl+N toggles
```

Install Neovim separately only if using embedded input. `NVIM` selects executable; otherwise PATH `nvim`. Terminal/tmux extended-key support affects Super/Meta commands; suppressing a warning does not configure the terminal.

### Build (mutating local artifacts, not deployment)

Node >=22.19.0 is required. Offline build needs installed locked dependencies and hydrated generated model data. On an isolated approved source workspace:

```bash
cd <pi-root>
npm ci --ignore-scripts
# If generated model data is absent, hydrate with separately admitted network access:
npm run hydrate:model-data
npm run build:offline
```

`build:offline` builds telemetry -> schema -> chord -> tui -> codemode -> mcp -> ai offline -> durable -> env -> agent -> coding-agent. AI checks preexisting generated model data; it fails if absent. Ordinary `npm run build` may refresh models over network. Package/platform native prerequisites remain in package guides; env daemon tests need a built Rust daemon where applicable.

Coding-agent build emits unbundled JS/types/assets (themes, PNG, Lua, HTML) and then bundle. CLI bin is `packages/coding-agent/dist/bundle/cli.js`; RPC entry is `dist/bundle/rpc-entry.js`. PX extension peers need unbundled package output as well. The bundle has external dependencies and is not a self-contained executable. Source/unbundled inspection alone cannot prove the running bundle is current.

## Options and configuration

| Name | Type | Default | Effect |
| --- | --- | --- | --- |
| `experimentalTuiLayout` | `standard` or `four-panel` | `standard` | Select host layout; restart |
| `/input` mode | `orig`, `nvim`, `both` | `orig` | Four-panel visibility; hidden editor remains alive |
| `NVIM` | Environment executable string | PATH `nvim` | Spawn embedded editor executable |
| `warnings.tmuxExtendedKeysFormat` | Boolean | `true` | Warning only, not tmux reconfiguration |
| `modelBorderColors` | Global-only object, exact provider/model -> hex | Absent | Matching model overrides manual border; unmatched preserves |
| `PI_TUI_BORDER_COLOR` | Internal optional hex string | Absent | Child handoff; valid trimmed hex normalized uppercase |
| `PI_TUI_BORDER_BRIGHTNESS` | Internal numeric string | `1` | Invalid/blank/nonfinite -> 1; clamp 0-1, linear-light border scaling |
| `app.input.toggle` | Keybinding | Super+/; Alt+/ in tmux | Input focus toggle |
| `app.input.interrupt` | Keybinding | Super+Escape | Embedded-input interrupt |
| Bash `timeout` | Optional number, seconds | None | Positive finite <=86,400, checked before spawn |
| Extension `argumentHint` | Optional string | Absent | Slash/RPC hint, not validation |
| `setDividerStatus` | Optional UI API | Feature-dependent | Keyed divider text; undefined removes |

Settings source: [settings](../packages/coding-agent/docs/settings.md), `core/settings-{defaults,schema}.ts`; keybindings and extension API are in their corresponding coding-agent docs/source.

## Files and state

`<sessionFile>.ui-state.json` is version 1: session ID, draft text, input panel mode, Neovim mode `i|n`, optional border color/null. Invalid JSON/version/identity/fields/color is ignored. Parent dirs are created 0700; exclusive random temporary files 0600 are renamed, with best-effort temp cleanup; deletion ignores missing files. **Drafts can be sensitive.** This is session UI state, not factory task state, and must not enter Git/docs/logs.

Ignored `node_modules`, generated `packages/ai/src/providers/data/`, and `packages/*/dist` are necessary runtime/build state, not backed up by a source commit. Schemas/locks are versioned where declared. Do not manually edit generated models; use catalog generation.

## PX compatibility pin

PX `compatibility.json` is the ledger, not the old Pi README. The reviewed ledger records:

| Field | Value |
| --- | --- |
| Host version | `1.5.0` |
| Upstream candidate | `085c84e98e7f4c950f2be606466fff4f75d8fe7c` |
| Latest named fork candidate | `c4b28cb3ee6ab6a18aec7be968c5fd5431d7d922` |
| Parent provenance | `2b1d8cc3864d07e7af925f5b2cb2aed6a4ad08af` |
| Status | Private source; reported fork/stock PX offline --all passes; fork unpublished candidate; global 1.5 release not accepted |

Intermediate named pins cover watcher convergence/readiness/reconciliation, fixtures, routing, divider status, timestamps, timeout units/guard, and argument hints. Use full commits and inspect merge parents, not a guessed linear ordering. OM/subagent manifests, locks, and guarded peer linkers must match selected host versions.

PX validation requires absolute `PI_SOURCE_DIR`/`PI_ARTIFACT_DIR`; npm is offline unless `PX_ALLOW_NPM_NETWORK=1`. Against a prepared pair, the **mutating validation** command is:

```bash
cd <px-root>
PI_SOURCE_DIR=<absolute-pi-source> PI_ARTIFACT_DIR=<absolute-pi-artifacts> scripts/validate.sh --all
```

If stock upstream is advertised compatible, build and check it separately too. The checker cannot prove artifacts in a different directory came from the selected source. Keep exact source/artifact provenance. Unix-oriented tools (Bash, Zsh, Neovim, rsync, Python) are needed. See PX `docs/README.md` and `scripts/validate.sh` in the companion checkout.

## Safety, deployment, and rollback

Pi remains standalone; companion installation is optional. Typical npm linking from `packages/coding-agent` changes the global CLI and is **deployment**, requiring conflict inspection and explicit authorization. In a devenv-managed installation, preserve Stow ownership; never ad hoc-copy deployed extensions or retarget links to a feature tree.

Before live promotion: record actual CLI symlink/global prefix, old Pi/PX tips, all generated peer links, service state, and effective policy. Create and verify a private rollback snapshot of ignored dependencies, model data, and built artifacts. Run parent Stow simulation and PX generated-dependency link plan before/after; no Stow apply is needed when targets stay unchanged. Only separately approved live source/artifact promotion may update canonical checkouts and rebuild linked output. **Rebuilding live dist changes deployment even without relinking.**

Verify CLI target/version, exact peers, source/artifact pair, and fresh UI/extension checks. Running sessions can retain old modules; coordinate reload/restart separately. Inspect actual services that invoke Pi. The older upgrade guide's promotion RunAtLoad instructions are historical: PX retired the v1 processor, and current recipient ingestion is different. Do not reload a retired job or assume source deletion stopped an installed process.

On failure, stop promotion, preserve failed artifacts, and use verified old refs plus artifact snapshot under a reviewed recovery plan. Quarantine new generated trees before restoring old ones to avoid mixed dependencies; do not reset/clean/stash/force-push. Reverify CLI/peers/Stow/policy before separately approved service resumption. Keep branches/worktrees/snapshots until accepted cleanup; Git alone does not restore ignored runtime output.

## Upstream sync process

This is a reviewed workflow, not automatic fetching/merging/deployment:

1. Inspect current Pi/PX/parent worktrees and installed identity; resolve upstream release, package version, and old tips; create backup refs with authorization.
2. Prepare a **parent devenv feature worktree**, then deliberate Pi/PX submodule branches/bases/dependencies inside it. Current factory instructions supersede the older guide's standalone-submodule worktree recipe. Never edit the live submodule as an incidental sync.
3. Fetch/review fork `origin` and upstream `upstream` tips. Resolve the intended immutable upstream commit; merge it into the fork candidate with `git merge --no-commit --no-ff <resolved-upstream-commit>`. Preserve two-parent history and inspect conflicts individually. The older guide uses `origin/main`; do not assume that ref is today's intended upstream.
4. Review exact dependencies and regenerate root/installer locks (`npm install --package-lock-only --ignore-scripts`, `node scripts/generate-coding-agent-install-lock.mjs`); retain fork dependencies and review lock diff. Use approved `PI_ALLOW_LOCKFILE_CHANGE=1` only for reviewed lock commits; never bypass hooks.
5. Install locked dependencies without lifecycle scripts, hydrate models, regenerate schemas if changed, run `npm run check` (writes formatting), offline build, focused tests, and credential-isolated `./test.sh` as admitted. Do not call a green subset broad acceptance.
6. Update PX exact commit/version ledger, peers/linkers, offline locks; validate explicit fork source/artifacts and separately built stock host if retained compatible. Update factory trust pins only through its reviewed procedure when exact hashed inputs changed.
7. Commit reviewed files with authorization; advance parent gitlinks in dependency order. Push/integrate/deploy are separate approvals; check remote tips, never force-push. GitLab is an optional manually pushed private copy, not an automatic mirror; use recipient-configured identity, no embedded organizational host/key assumptions.

**Migration note:** `<pi-root>` and `<px-root>` are canonical prepared source/artifact identities, not active aliases. The `devenv` branch need not be renamed with forge-factory. Cwd mapping and legacy deployment paths require deliberate portability work; see the external forge-factory `docs/roadmap.md`.

## Failure and recovery

| Symptom | Check/action |
| --- | --- |
| Offline build missing models | Hydrate admitted generated data; do not weaken model types |
| New code absent in CLI | Verify bundle/bin link and rebuild approved artifacts; source is not executable identity |
| PX peer rejection | Exact source commit/version, unbundled JS/types, typebox/linker pins; no fallback to arbitrary host |
| Invalid UI sidecar | Ignored safely; protect drafts and avoid manual duplicate writers |
| Missing Neovim/key reporting | Executable/PATH, layout, terminal/tmux capabilities; warning suppression is not a fix |
| Missed plugin event | Native readiness and bounded reconciliation limits; on-demand builds remain; no lossless guarantee |
| Conflict beyond own changes | Stop/reconcile under repo rules; no wholesale file choice or published-history rewrite |

## Tests and verification boundary

Relevant tests: TUI `editor`, `mouse-components`, `tui-alt-screen`; coding-agent `message-timestamp`, custom-output routing, `interactive/input-session-state`, input-state, Neovim viewport, clear-output, model/session selectors, border/settings, divider/status, extension-runner, Bash renderer/tools; Chord plugin `plugins`, `reconcile`, `watcher` and HTTP upgrade tests. Package instructions define exact runners.

For docs-only changes, no build/test execution is needed or claimed here. `npm run check` mutates files; `npm test` requires explicit request; use `./test.sh` for admitted non-E2E broad suites or focused package tests. Historical selected builds/tests and UI checks passed, but the broad Pi suite remains non-green and global 1.5 release unaccepted. Do not use this document as a release certificate.

## Related

- [Pi root README](../README.md) and [coding-agent documentation](../packages/coding-agent/README.md)
- [Settings](../packages/coding-agent/docs/settings.md), [native watch readiness](../packages/chord/docs/native-watch-readiness.md), [reconciliation](../packages/chord/docs/native-watch-reconciliation.md)
- Parent devenv `harness/PI-UPSTREAM-UPGRADE.md` (historical procedures; use current ownership/service rules)
- Companion PX `docs/README.md` and `compatibility.json`
- External forge-factory `docs/{README,roadmap}.md` and `docs/history/{chronology,retrospective}.md`
