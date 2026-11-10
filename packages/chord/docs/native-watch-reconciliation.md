# Native watch reconciliation

## Decision and best-effort contract

Owner decision (2026-11-10, option A; recorded in `decisions.md`): use a **finite, best-effort registration window**,
not permanent polling. `fs.watch()` exposes no readiness or overflow signal. FSEvents can lose an edit before
asynchronous registration, including when a handle change rebuilds the shared stream (`native-watch-readiness.md`).
The window recovers persistent metadata differences around Chord's own registrations and topology changes; it is
not a readiness barrier or a guarantee of lossless event delivery. In particular, an unrelated watcher's later
registration or close can rebuild the shared FSEvents stream after the window ends; Chord cannot detect that
rebuild, and this mechanism cannot guarantee recovery of events lost then. Native events remain authoritative
invalidation signals outside the window. Builds and reloads remain explicit, with on-demand builds available.

## Window and resource bounds

Each directory gets a pre-registration snapshot of its immediate, non-ignored children. A Chord registration or
removal starts a window on all directories this PluginWatcher tracks, since libuv can rebuild a shared stream.
Scans start at approximately 0, 250 ms, 1 s and 3 s after the topology change. The first pass covers immediate edits;
the later, progressively spaced passes allow asynchronous registration to settle without claiming a readiness
deadline. These are engineering choices, not measured FSEvents guarantees. After four passes, no reconciliation
timer remains. Timers are unreferenced. A later Chord topology change starts another finite window; a change during
a sweep gets a complete new first pass after that sweep, rather than counting a partial old pass as its first.

A sweep advances at most 256 iterator steps per timer turn, 10 ms between chunks. Large sweeps may finish after
the target times; passes never overlap, and overdue passes follow serially. At most one directory iterator is held
by a sweep. Baseline capture remains synchronous, like existing native watch-tree registration; registration of
a newly discovered subtree can exceed the incremental sweep's per-turn work budget.

Snapshots retain at most 100,000 child records and 100,000 directory records per watcher. Each tree-directory
iteration is limited to 100,000 non-ignored children. Base-only directories are not enumerated: only explicitly
tracked base-file names are statted and counted. Unrelated siblings cannot exhaust their reconciliation budget.
Close cancels the timer, closes a suspended iterator and drops all snapshots.

Reconciliation errors (including a limit or EACCES on a child) **never close or disable native watches**. Only the
affected directory's reconciliation snapshot is discarded; other directories continue their finite scans. The
existing error callback receives a diagnostic explicitly stating that reconciliation was skipped and native
watching remains active. A later registration can attempt a new baseline. No public options or error kinds are
added. Native registration/handle errors retain their separate, existing report-once/native-close fallback.

## Observations and identity safety

Repeated sweeps compare lstat identity, type, nanosecond mtime/ctime and size; additions, removals and differences
enter the existing mark path. Directory fingerprints use identity and mode only: their children detect content
changes, and timestamps would spuriously invalidate for changes to ignored children. Symlinks are never traversed
by reconciliation. New directories are snapshotted before their watches start, then scanned within the new window.

The registered directory's lstat dev/ino and directory type are captured before baseline traversal. Before opening
a scan iterator, and before resolving each child after a yield, reconciliation checks that identity again. A missing
directory, symlink or different inode is marked as a change and forgotten, without traversing the replacement.
A suspended iterator refers to the original opened directory, not the replacement; child path operations stop on
the next identity check. These path-based checks are not a security sandbox: Node's directory API offers no atomic
lstat-plus-O_NOFOLLOW directory open, so an external mutation between a check and an OS call remains a TOCTOU race.
No probe files are written, and no content is read by reconciliation.

Native observations refresh matching snapshots before marking, avoiding ordinary native-event/scan duplicates.
Late native events can still conservatively mark: marks are invalidations, not an event count. Never suppress a
native event because metadata is unchanged; exact-byte build input hashes remain the code-content authority.
This is not a filesystem event journal: reverted edits between observations, metadata-preserving content changes,
and edits outside the finite window need not be recovered by reconciliation. O(entries) bounded memory and
metadata calls per pass are intentional costs; there is no idle polling cost after the window.

## Design check and tests

- `design.md` §1 and §21, slice 7c §5, slice 12 §4: watcher only marks; reload and rollout stay explicit. Ignored
  directories, linked plugin roots, copied inputs, base files, install/discovery marks retain their existing rules.
- Existing monotonically increasing generations remain the sole clear fence. A reconciliation after a build
  snapshot gets a newer generation, so an older rollout cannot clear it. A duplicate may cause a redundant rebuild,
  never a lost invalidation; discovery has the same generation rule.
- §30: cost is explicit, finite and bounded. Snapshots belong to the watcher; there is no global cache or public
  configuration surface. Metadata comparison does not replace the build's exact-byte content hashes.
- Deterministic tests withhold native callbacks, advance window timers, and explicitly deliver topology events.
  They cover registration recovery, generation fences, finite termination, chunking, replacement between scan turns,
  base-only selection, EACCES and resource-limit diagnostics without losing native coverage. Existing native tests
  and assertions are unchanged.
