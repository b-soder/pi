# Native watch test readiness on macOS

## Problem and evidence (2026-11-10)

Native plugin-watch tests intermittently exhausted their 5 s deadlines. A write made after `fs.watch()` returns is
not necessarily made after the native subscription starts. This is observable without Chord, Vitest or parallel
workers; it is not just a slow assertion.

Investigation used Node v26.13.0, bundled libuv 1.53.0, macOS, with 18 available CPUs. The raw experiment created
12 separate directories, registered a directory watch on each, then wrote `target` in the last directory. Each
trial waited up to 7 s for that exact filename, then closed its watches. Across 30 trials per mode:

| Stimulus after registration | Missing target events after 7 s |
| --- | --- |
| Synchronous write | 16/30 |
| Async write | 22/30 |
| Async write after observing a real probe event on the same loop | 0/30 |

A single-directory control had 0/30 losses with or without the handshake. The two-file Chord watcher/plugins
baseline batch reproduced two 5 s timeouts. Serialization alone also passed one batch, but cannot eliminate the
raw, single-process registration race.

The native path is Node `fs.watch` -> bundled libuv -> FSEvents for **directories**, not chokidar or the npm
`fsevents` package. libuv's kqueue implementation opens the path, determines it is a directory, closes that
fallback descriptor and uses `uv__fsevents_init`. Files and fallback cases use kqueue.

In libuv 1.53.0:

- `uv__fsevents_init` queues registration on a separate Core Foundation loop; it does not wait for stream readiness.
- `uv__fsevents_reschedule` destroys and recreates the shared stream when its handle set changes.
- `uv__fsevents_create_stream` starts from `kFSEventStreamEventIdSinceNow`, with 0.05 s latency and
  `NoDefer | FileEvents`. An edit before that stream starts need not be replayed. A longer assertion timeout cannot
  restore such an edit.
- System/drop flags are not exposed as an overflow notification through Node's `fs.watch` callback.

Sources: [libuv fsevents.c](https://github.com/libuv/libuv/blob/v1.53.0/src/unix/fsevents.c),
[kqueue.c](https://github.com/libuv/libuv/blob/v1.53.0/src/unix/kqueue.c).

Confidence is high that registration loss explains these native-event timeouts: the raw failure needs only 12
handles, and a real-event readiness handshake removes it in the measured sample. This is not proof that every
historical timeout had that cause. No kernel-level tracing or exhaustive overflow study was performed. The observed
fd limit was 1,048,575; macOS reported `kern.maxfiles=491520`, `kern.maxfilesperproc=245760`. The minimal reproduction
needs neither descriptor exhaustion nor competing suites. It distinguishes missing events over 7 s from events merely
arriving a little past 5 s, not permanent loss over an unlimited observation period.

## Harness fix

`test/node/plugins/support.ts` supplies a macOS-only `nativeWatchReady()` barrier. It registers a watch on its **own
separate temporary directory**, outside every plugin/base root, and repeats a write until that handle receives its
exact `ready` filename. That callback cannot call `PluginWatcher.mark` or satisfy any tested plugin event. A guard
test verifies that multiple barriers produce no marks, then still requires a real event at the exact target path.

The barrier is bounded at 2 s and throws a distinct readiness error if it sees no event. This is a new setup bound,
not a shortened native assertion deadline. Probe handles remain open until test teardown: closing one sooner would
itself rebuild the shared stream. No watch options, production paths, assertion relaxations or event suppression were
added. All original native assertions and 5 s deadlines remain.

Call sites establish the barrier before native stimuli and after topology changes such as adding watches for a new
subdirectory or removing a plugin. The watcher fixture also puts its writes before a pre-construction barrier:
otherwise fixture creation can still be entering the filesystem journal when the tested stream starts, producing
legitimate setup events inside assertions intended to test only synchronous manual marks. This boundary changes no
mark handling and discards no event from a live tested watcher.

Chord's Vitest config does not override pool size or file parallelism. Installed Vitest 4.1.12 uses parallel files
and a default fork pool, with non-watch worker count based on available CPUs minus one (17 here). Root `./test.sh`
invokes npm's workspace test runner, which runs package scripts sequentially, not concurrently. Within Chord, many
files still run concurrently. No concurrency configuration was changed.

## Production follow-up (not implemented)

Real users can miss an edit in the first moments after a directory watch starts, or while libuv rebuilds its shared
stream. This harness fix does **not** make production `PluginWatcher` ready or lossless. Adding probe writes to user
plugin directories is not an acceptable production substitute.

Investigate a production post-start reconciliation/rescan design, including new-directory registration and stream
reconfiguration, with generation rules that preserve edits during discovery/build. Node exposes no ready event, so a
single arbitrary sleep followed by a scan is not a readiness guarantee. Consider bounded repeated reconciliation or a
backend with explicit readiness and overflow reporting; decide its cost and recovery contract separately. Retain the
current on-demand build fallback and native events. No production change was made in this task.

## Validation and retained evidence

Private experiment scripts, raw event timestamps, fetched native source and command output are retained in
`~/.local/state/devenv/s3-flake-watch/` (directory mode 0700). No credentials or live provider calls were used.

Commands run in this worktree:

- `npm ci --ignore-scripts --offline`: passed.
- `npm run build:offline`: initially blocked by absent generated model data; after `npm run hydrate:model-data`, passed.
- From `packages/chord`: `node ../../node_modules/vitest/dist/cli.js --run test/node/plugins/watcher.test.ts test/node/plugins/plugins.test.ts`:
  final batch passed (39 passed, 1 skipped).
- From `packages/chord`: `node ../../node_modules/vitest/dist/cli.js --run`: final suite passed
  (225 files passed, 12 skipped; 3,194 tests passed, 52 skipped).
- `./test.sh`: run twice, within the three-run budget. First run had no native timeouts but one fixture setup mark
  race, corrected with the pre-construction boundary. Second run's entire Chord suite passed with the counts above.
  Both full runs failed elsewhere on four AI catalog tests (including the absent Fireworks
  `accounts/fireworks/models/nemotron-3-ultra-nvfp4`) and seven env suites requiring the unbuilt Rust daemon.
- `npm run check`: lint/dependency/entry-graph/install-lock checks passed; TypeScript was blocked by existing AI
  Fireworks model-test type errors. No Chord error was reported. These unrelated failures were not modified.

No commits, deployment links, live services or production watcher behavior changed.
