# Isolated fork coverage baseline

This measures executable TypeScript under `packages/*/src` changed from the selected upstream ref. Touched-file line coverage and authored-added-line coverage use the same Istanbul identity: a physical line is executable when it is a statement start line; continuation, comment, and brace-only lines do not add denominator entries. Tests, docs, JSON schemas/themes, generated data, package metadata, and embedded Lua assets are inventoried but excluded from executable-source coverage. New or modified production files with no hits remain in the report at zero; files with no executable statements have a zero denominator and a null percentage.

## Prepare the isolated worktree

Preparation is intentionally separate from the runner. It writes ignored model data, package `dist/` output, and a local daemon binary:

```sh
npm run hydrate:model-data
npm run build:offline
npm --prefix packages/env run build:daemon
```

Hydration fetches public model catalogs and model-list/config endpoints; it does not call provider inference APIs and needs no provider credentials. `build:offline` validates the hydrated data and builds workspace artifacts without refreshing catalogs. The Env daemon uses `cargo build --locked`; Cargo may fetch public crates if they are not cached. The runner does not perform any preparation step and stops if required artifacts are missing.

## Run

```sh
node scripts/coverage-px-pi.mjs --base v1.5.2 --output /tmp/pi-coverage-px-pi
```

The runner executes the supported `./test.sh` suite, preserving its sanitized environment, offline behavior, and package test commands. It enables Vitest V8 coverage only in the Chord, coding-agent, and Durable configs while `PI_COVERAGE_DIR` is set. The test runner forwards `NODE_V8_COVERAGE` to Node tests and child processes; this captures the TUI `node:test` suite and spawned Node processes. Default test behavior is unchanged.

The output directory contains the full test log, per-workspace Vitest JSON coverage, raw Node V8 profiles, and `report.json`. The report records test exit status, baseline/head SHAs, worktree dirty paths, hashes of measured sources, changed test inputs and measurement configs, the separate generated model-data manifest, all changed paths and exclusions, all touched executable files, package and aggregate line/branch totals, and authored added-executable-line coverage. Raw Node profiles are merged by script URL before source-map remapping. If Node and Vitest executable source-line sets match, line hits are merged by source line. Branch hits are combined only when exact statement/function/branch source locations and arm identities match, independent of numeric coverage IDs; otherwise the report keeps the Vitest branch map and records both raw-Node and retained-Vitest numerators/denominators. The aggregate branch percentage is the retained per-file map metric, not an exhaustive union of incompatible branch maps. TUI files without Vitest reports use Node V8 profiles converted through the same AST-aware Istanbul converter.

## Known full-suite caveat

The recorded full-suite run exited 1 on `packages/ai/test/together-models.test.ts`: the test expected Together Kimi K3 `maxTokens: 131072`, while the public catalog snapshot used for this run supplied `1048576`. This is a catalog/test expectation mismatch, not a green full-suite result. The report retains the model-data manifest and hashes so the measurement's generated catalog snapshot can be identified. No product change was made for this failure.

Run the coverage helper tests without preparing/building anything:

```sh
node --test scripts/coverage-px-pi.test.mjs
```
