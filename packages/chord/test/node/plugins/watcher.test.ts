// Tests of the watcher (slice 7c §5, slice 12 §4): dirty marks from the files facets used and from plugin directories,
// `install`, `set`, `base`, a change during a build keeping its mark, `node_modules` and `.git` ignored, real file
// events, the marks as a JSON watchable, and single-file plugins' files.

import { readdirSync, readFileSync } from "node:fs";
import { realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, it, onTestFailed, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { type BuiltFacet, discoverPlugins } from "../../../src/node/plugins/index.ts";
import { type PluginsState, PluginWatcher } from "../../../src/node/plugins/watcher.ts";
import { Batch } from "../../../src/state/internal.ts";
import { changesOf, delivered } from "../../support.ts";
import { KINDS, tempRoot, writeFiles, writePlugin } from "./support.ts";

type MarkObserver = { calls: { path: string; kind: "native" | "manual" }[]; manual: boolean; base: string };

/** A root with plugins `a` (worker), `b` (server) and the contracts fixture, a base directory, and a watcher of both. */
async function watched(observer?: MarkObserver) {
	const root = await realpath(await tempRoot(["contracts"]));
	const base = await realpath(await tempRoot());
	await writePlugin(root, "a", "@test/a", { "worker.ts": "", "own.ts": "" });
	await writePlugin(root, "b", "@test/b", { "server.ts": "" });
	const failures: unknown[] = [];
	const watcher = new PluginWatcher(
		{ roots: [root], base: [base], kinds: KINDS, failed: (error) => failures.push(error) },
		new Batch(() => {}, undefined),
	);
	if (observer) {
		observer.base = base;
		const mark = watcher.mark.bind(watcher);
		watcher.mark = (path) => {
			observer.calls.push({ path, kind: observer.manual ? "manual" : "native" });
			mark(path);
		};
	}
	const discoveryStarted = watcher.discoverySnapshot();
	const discovery = await discoverPlugins([root], { kinds: KINDS }, context);
	watcher.know(discovery, discoveryStarted);
	const contract = join(root, "contracts", "contract.ts");
	const used = (plugin: string, facet: string, files: readonly string[]): BuiltFacet => ({
		kind: "script",
		plugin,
		facet,
		source: "",
		digest: "",
		inputs: files.map((file) => ({ file, hash: "" })),
		copied: [contract],
		assets: [],
	});
	const built = [
		used("@test/a", "worker", [join(root, "a", "worker.ts"), contract]),
		used("@test/b", "server", [join(root, "b", "server.ts"), contract]),
	];
	// Register the fixture facets' read ownership; setup itself claims no install or applied build.
	watcher.used(built);
	return { root, base, watcher, failures, discovery };
}

/** Read the watcher's state, which its JSON-valued getter constructs in the PluginsState shape. */
function watcherState(watcher: PluginWatcher): PluginsState {
	return watcher.value as unknown as PluginsState;
}

/** Check the remaining state and every observed path against the fixture and the test's deliberate paths. */
function explainMarks(
	root: string,
	watcher: PluginWatcher,
	observer: MarkObserver,
	target: string,
	extra: string[],
	singleFile: string[] = [],
) {
	const path = (...parts: string[]) => join(root, ...parts);
	const setup = [
		root,
		path("a"),
		path("a", "a"),
		path("a", "package.json"),
		path("a", "worker.ts"),
		path("a", "own.ts"),
		path("b"),
		path("b", "b"),
		path("b", "package.json"),
		path("b", "server.ts"),
		path("contracts"),
		path("contracts", "contracts"),
		path("contracts", "package.json"),
		path("contracts", "contract.ts"),
	];
	const inBase = (entry: string) => {
		const rest = relative(observer.base, entry);
		return rest !== "" && !rest.startsWith("..") && !isAbsolute(rest);
	};
	for (const entry of [target, ...extra, ...singleFile]) expect(entry === observer.base || inBase(entry)).toBe(false);
	for (const call of observer.calls) {
		if (call.path === observer.base || inBase(call.path)) {
			expect(call.kind).toBe("native");
		} else {
			expect(
				call.kind === "manual" ? [target, ...singleFile] : [...setup, target, ...extra, ...singleFile],
			).toContain(call.path);
		}
	}
	const native = observer.calls.filter((call) => call.kind === "native").map((call) => call.path);
	const state = watcherState(watcher);
	const explains = (paths: string[]) => paths.some((entry) => native.includes(entry));
	for (const name of state.dirty) {
		if (name === "@test/a")
			expect(
				observer.calls.some((call) => call.kind === "manual" && call.path === target) ||
					(singleFile.length > 0 &&
						explains([
							path("a"),
							path("a", "a"),
							path("a", "worker.ts"),
							path("a", "own.ts"),
							path("contracts", "contract.ts"),
						])),
			).toBe(true);
		else if (name === "hello") expect(singleFile.length > 0 && explains(singleFile)).toBe(true);
		else if (name === "@test/b")
			expect(explains([path("b"), path("b", "b"), path("b", "server.ts"), path("contracts", "contract.ts")])).toBe(
				true,
			);
		else if (name === "@test/contracts")
			expect(explains([path("contracts"), path("contracts", "contracts"), path("contracts", "contract.ts")])).toBe(
				true,
			);
		else expect.fail(`Unexplained dirty plugin: ${name}`);
	}
	for (const name of state.install) {
		const manifests: Record<string, string> = {
			"@test/a": path("a", "package.json"),
			"@test/b": path("b", "package.json"),
			"@test/contracts": path("contracts", "package.json"),
		};
		expect(native).toContain(manifests[name]);
	}
	if (state.set)
		expect(
			explains([
				path("a"),
				path("b"),
				path("contracts"),
				path("a", "worker.ts"),
				path("b", "server.ts"),
				...singleFile,
			]),
		).toBe(true);
	// The base directory itself and ignored paths cannot set base in mark().
	if (state.base)
		expect(
			native.some(
				(entry) => inBase(entry) && !entry.split(sep).some((part) => part === "node_modules" || part === ".git"),
			),
		).toBe(true);
}

/** Apply the observed A generation and check a separate synchronous manual mark without clearing other state. */
function applyAndMark(watcher: PluginWatcher, observer: MarkObserver, target: string) {
	const before = watcherState(watcher);
	const count = observer.calls.length;
	const applied = watcher.snapshot(["@test/a"]);
	watcher.applied(["@test/a"], applied);
	expect(observer.calls.length).toBe(count);
	expect(watcher.value).toEqual({ ...before, dirty: before.dirty.filter((name) => name !== "@test/a") });
	const prior = watcherState(watcher);
	const manualCount = observer.calls.length;
	observer.manual = true;
	watcher.mark(target);
	observer.manual = false;
	expect(observer.calls.slice(manualCount)).toEqual([{ path: target, kind: "manual" }]);
	expect(watcher.value).toEqual({ ...prior, dirty: [...new Set([...prior.dirty, "@test/a"])].sort() });
}

describe("the watcher's marks", () => {
	it("dirties every plugin whose facets used a changed file, and the plugin whose directory contains it", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "contracts", "contract.ts"));
		expect(watcher.value).toEqual({
			dirty: ["@test/a", "@test/b", "@test/contracts"],
			install: [],
			set: false,
			base: false,
		});
		watcher.close();
	});

	it("dirties the plugin of a file no facet read yet; asks for an install for a package.json", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "a", "new.ts"));
		watcher.mark(join(root, "b", "package.json"));
		expect(watcher.value).toEqual({ dirty: ["@test/a"], install: ["@test/b"], set: false, base: false });
		// Installed: the mark clears, and the plugin is dirty (its packages changed).
		watcher.installed("@test/b");
		expect(watcher.value).toEqual({ dirty: ["@test/a", "@test/b"], install: [], set: false, base: false });
		watcher.close();
	});

	it("asks for discovery for a directory under a root and a facet file at a plugin's top; base for base code", async () => {
		const { root, base, watcher } = await watched();
		watcher.mark(join(root, "c"));
		expect(watcher.value).toMatchObject({ set: true, dirty: [] });
		const seen = watcher.discoverySnapshot();
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		// `set` has no event identity and is cleared by discovery, not by `applied` for a plugin build.
		expect(watcher.value).toMatchObject({ set: false });
		watcher.mark(join(root, "b", "web.tsx"));
		expect(watcher.value).toMatchObject({ set: true, dirty: ["@test/b"] });
		watcher.mark(join(base, "core.ts"));
		expect(watcher.value).toMatchObject({ base: true });
		watcher.close();
	});

	it("marks base for a base file given one by one, not for its siblings; never under node_modules", async () => {
		const { base, watcher } = await watched();
		const elsewhere = await realpath(await tempRoot());
		await writeFiles(elsewhere, { "entry.ts": "", "sibling.ts": "", "node_modules/react/index.js": "" });
		watcher.baseFiles([join(elsewhere, "entry.ts"), join(elsewhere, "node_modules", "react", "index.js")]);
		watcher.mark(join(elsewhere, "sibling.ts"));
		watcher.mark(join(elsewhere, "node_modules", "react", "index.js"));
		expect(watcher.value).toMatchObject({ base: false });
		// A real event on the file: its directory is watched.
		await writeFile(join(elsewhere, "entry.ts"), "export {};");
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ base: true }), { timeout: 5_000 });
		expect(base).not.toBe(elsewhere);
		watcher.close();
	});

	it("ignores node_modules and .git", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "a", "node_modules", "x", "index.js"));
		watcher.mark(join(root, "a", ".git", "HEAD"));
		expect(watcher.value).toEqual({ dirty: [], install: [], set: false, base: false });
		watcher.close();
	});

	it("removes a deleted plugin's read ownership from future marks", async () => {
		const { root, watcher, discovery } = await watched();
		const contract = join(root, "contracts", "contract.ts");
		const names = ["@test/a", "@test/b", "@test/contracts"];
		const registered = watcher.snapshot(names);
		watcher.applied(names, registered);
		watcher.mark(contract);
		expect(watcher.value).toMatchObject({ dirty: ["@test/a", "@test/b", "@test/contracts"] });
		const current = watcher.snapshot(names);
		watcher.applied(names, current);
		expect(watcher.value).toMatchObject({ dirty: [] });

		watcher.know(
			{ ...discovery, plugins: discovery.plugins.filter(({ name }) => name !== "@test/b") },
			watcher.discoverySnapshot(),
		);
		watcher.mark(contract);
		expect(watcher.value).toMatchObject({ dirty: ["@test/a", "@test/contracts"] });
		watcher.close();
	});

	it("keeps the mark of a change during a build: only an unchanged mark clears when applied", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "a", "own.ts"));
		const snapshot = watcher.snapshot(["@test/a"]);
		// Saved again while the build runs.
		watcher.mark(join(root, "a", "own.ts"));
		watcher.applied(["@test/a"], snapshot);
		expect(watcher.value).toMatchObject({ dirty: ["@test/a"] });
		watcher.applied(["@test/a"], watcher.snapshot(["@test/a"]));
		expect(watcher.value).toMatchObject({ dirty: [] });
		// A discovery that started before a change of the set keeps `set`.
		const seen = watcher.discoverySnapshot();
		watcher.mark(join(root, "d"));
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		expect(watcher.value).toMatchObject({ set: true });
		watcher.close();
	});

	it("marks from real file events, publishing the marks to a watch", async () => {
		let stage = "fixture-roots";
		onTestFailed(() => console.error(stage));
		const observer: MarkObserver = { calls: [], manual: false, base: "" };
		const { root, watcher } = await watched(observer);
		const changes = changesOf(await watcher.watch(context));
		expect(watcher.value).toEqual({ dirty: [], install: [], set: false, base: false });
		expect(watcher.value).toMatchObject({ dirty: expect.not.arrayContaining(["@test/a"]) });
		const target = join(root, "a", "node_modules-free.ts");
		const start = observer.calls.length;
		stage = "native-event-write";
		await writeFile(target, "export {};");
		await writeFiles(join(root, "b", "node_modules", "pkg"), { "index.js": "" });
		stage = "native-event-observed";
		await vi.waitFor(
			() => {
				expect(observer.calls.slice(start)).toContainEqual({ path: target, kind: "native" });
				expect(watcher.value).toMatchObject({ dirty: expect.arrayContaining(["@test/a"]) });
			},
			{ timeout: 5_000 },
		);
		stage = "publication-delivery";
		await delivered();
		expect(changes.at(-1)).toMatchObject({ kind: "value", value: { dirty: expect.arrayContaining(["@test/a"]) } });
		applyAndMark(watcher, observer, target);
		explainMarks(root, watcher, observer, target, [
			join(root, "b", "node_modules"),
			join(root, "b", "node_modules", "pkg"),
			join(root, "b", "node_modules", "pkg", "index.js"),
		]);
		watcher.close();
	});
});

describe("the watcher and single-file plugins (slice 12 §4)", () => {
	it("dirties a single-file plugin for a change of its file; a file appearing or disappearing at a root's top sets set", async () => {
		const observer: MarkObserver = { calls: [], manual: false, base: "" };
		const { root, watcher } = await watched(observer);
		const server = join(root, "hello.server.ts");
		const web = join(root, "hello.web.tsx");
		const paths = [server, web];
		expect(watcher.value).toMatchObject({ dirty: expect.not.arrayContaining(["hello"]) });
		explainMarks(root, watcher, observer, server, [], paths);
		let start = observer.calls.length;
		await writeFiles(root, { "hello.server.ts": "" });
		await vi.waitFor(
			() => {
				expect(observer.calls.slice(start)).toContainEqual({ path: server, kind: "native" });
				expect(watcher.value).toMatchObject({ set: true });
			},
			{ timeout: 5_000 },
		);
		explainMarks(root, watcher, observer, server, [], paths);
		const seen = watcher.discoverySnapshot();
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		explainMarks(root, watcher, observer, server, [], paths);
		// Applying clears only hello's observed generation, not concurrent setup marks.
		let before = watcherState(watcher);
		watcher.applied(["hello"], watcher.snapshot(["hello"]));
		expect(watcher.value).toEqual({ ...before, dirty: before.dirty.filter((name) => name !== "hello") });
		before = watcherState(watcher);
		let manualStart = observer.calls.length;
		observer.manual = true;
		watcher.mark(server);
		observer.manual = false;
		expect(observer.calls.slice(manualStart)).toEqual([{ path: server, kind: "manual" }]);
		expect(watcher.value).toEqual({ ...before, dirty: [...new Set([...before.dirty, "hello"])].sort() });
		start = observer.calls.length;
		await writeFiles(root, { "hello.web.tsx": "" });
		await vi.waitFor(
			() => {
				expect(observer.calls.slice(start)).toContainEqual({ path: web, kind: "native" });
				expect(watcher.value).toMatchObject({ set: true });
			},
			{ timeout: 5_000 },
		);
		explainMarks(root, watcher, observer, server, [], paths);
		before = watcherState(watcher);
		watcher.applied(["hello"], watcher.snapshot(["hello"]));
		expect(watcher.value).toEqual({ ...before, dirty: before.dirty.filter((name) => name !== "hello") });
		before = watcherState(watcher);
		manualStart = observer.calls.length;
		observer.manual = true;
		watcher.mark(web);
		observer.manual = false;
		expect(observer.calls.slice(manualStart)).toEqual([{ path: web, kind: "manual" }]);
		expect(watcher.value).toEqual({ ...before, set: true });
		const webSeen = watcher.discoverySnapshot();
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), webSeen);
		explainMarks(root, watcher, observer, server, [], paths);
		start = observer.calls.length;
		await rm(server);
		await vi.waitFor(
			() => {
				expect(observer.calls.slice(start)).toContainEqual({ path: server, kind: "native" });
				expect(watcher.value).toMatchObject({ set: true, dirty: expect.arrayContaining(["hello"]) });
			},
			{ timeout: 5_000 },
		);
		explainMarks(root, watcher, observer, server, [], paths);
		before = watcherState(watcher);
		watcher.applied(["hello"], watcher.snapshot(["hello"]));
		expect(watcher.value).toEqual({ ...before, dirty: before.dirty.filter((name) => name !== "hello") });
		before = watcherState(watcher);
		manualStart = observer.calls.length;
		observer.manual = true;
		watcher.mark(server);
		observer.manual = false;
		expect(observer.calls.slice(manualStart)).toEqual([{ path: server, kind: "manual" }]);
		expect(watcher.value).toEqual({ ...before, dirty: [...new Set([...before.dirty, "hello"])].sort(), set: true });
		explainMarks(root, watcher, observer, server, [], paths);
		watcher.close();
	});
});

describe("the watcher, fix round 1", () => {
	it("never lets an older build's applied snapshot clear a newer edit's mark (Astra)", async () => {
		const { root, watcher } = await watched();
		const file = join(root, "a", "own.ts");
		watcher.mark(file);
		const first = watcher.snapshot(["@test/a"]);
		watcher.mark(file);
		const second = watcher.snapshot(["@test/a"]);
		watcher.applied(["@test/a"], second);
		expect(watcher.value).toMatchObject({ dirty: [] });
		watcher.mark(file);
		watcher.applied(["@test/a"], first);
		expect(watcher.value).toMatchObject({ dirty: ["@test/a"] });
		watcher.close();
	});

	it("drops the install mark of a plugin the next discovery no longer has (example 38)", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "b", "package.json"));
		expect(watcher.value).toMatchObject({ install: ["@test/b"] });
		await rm(join(root, "b"), { recursive: true });
		const seen = watcher.discoverySnapshot();
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		expect(watcher.value).toMatchObject({ install: expect.not.arrayContaining(["@test/b"]) });
		watcher.close();
	});

	it.skipIf(process.platform !== "linux")(
		"puts no watch on node_modules or .git (Opus N2): 200 packages add no inotify watch",
		async () => {
			const root = await realpath(await tempRoot());
			const dir = await writePlugin(root, "a", "@test/a", { "worker.ts": "" });
			for (let i = 0; i < 200; i++)
				await writeFiles(join(dir, "node_modules", `pkg${i}`, "lib"), { "index.js": "" });
			await writeFiles(join(dir, ".git", "objects"), { x: "" });
			const before = inotifyWatches();
			const watcher = new PluginWatcher(
				{ roots: [root], base: [], kinds: KINDS, failed: () => {} },
				new Batch(() => {}, undefined),
			);
			// The root and the plugin's directory.
			expect(inotifyWatches() - before).toBe(2);
			watcher.close();
		},
	);

	it("watches a directory that appears later, and marks the files in it", async () => {
		const observer: MarkObserver = { calls: [], manual: false, base: "" };
		const { root, watcher } = await watched(observer);
		const dir = join(root, "a", "lib");
		const first = join(dir, "first.ts");
		const second = join(dir, "second.ts");
		const extra = [dir, join(dir, "lib"), second];
		expect(watcher.value).toMatchObject({ dirty: expect.not.arrayContaining(["@test/a"]) });
		explainMarks(root, watcher, observer, first, extra);
		const start = observer.calls.length;
		await writeFiles(dir, { "first.ts": "" });
		await vi.waitFor(
			() => {
				expect(observer.calls.slice(start).some((call) => call.kind === "native" && call.path === dir)).toBe(true);
				expect(watcher.value).toMatchObject({ dirty: expect.arrayContaining(["@test/a"]) });
			},
			{ timeout: 5_000 },
		);
		// Model applying the first observed change before the later native event check.
		const beforeFirst = watcherState(watcher);
		const firstBuild = watcher.snapshot(["@test/a"]);
		watcher.applied(["@test/a"], firstBuild);
		expect(watcher.value).toEqual({ ...beforeFirst, dirty: beforeFirst.dirty.filter((name) => name !== "@test/a") });
		explainMarks(root, watcher, observer, first, extra);
		const secondStart = observer.calls.length;
		await writeFile(second, "export {};");
		await vi.waitFor(
			() => {
				expect(observer.calls.slice(secondStart)).toContainEqual({ path: second, kind: "native" });
				expect(watcher.value).toMatchObject({ dirty: expect.arrayContaining(["@test/a"]) });
			},
			{ timeout: 5_000 },
		);
		// Apply the second native change before the independent manual mark, so it cannot make that native assertion pass.
		applyAndMark(watcher, observer, first);
		explainMarks(root, watcher, observer, first, extra);
		const beforeManualApply = watcherState(watcher);
		const manualBuild = watcher.snapshot(["@test/a"]);
		watcher.applied(["@test/a"], manualBuild);
		expect(watcher.value).toEqual({
			...beforeManualApply,
			dirty: beforeManualApply.dirty.filter((name) => name !== "@test/a"),
		});
		explainMarks(root, watcher, observer, first, extra);
		watcher.close();
	});
});

describe("the watcher and links", () => {
	it("survives a link loop created under a root (its stat never escapes the callback) and still marks it (Sol)", async () => {
		const observer: MarkObserver = { calls: [], manual: false, base: "" };
		const { root, watcher, failures } = await watched(observer);
		const target = join(root, "a", "loop");
		expect(watcher.value).toMatchObject({ dirty: expect.not.arrayContaining(["@test/a"]) });
		explainMarks(root, watcher, observer, target, []);
		const start = observer.calls.length;
		await symlink("loop", target);
		await vi.waitFor(
			() => {
				expect(observer.calls.slice(start)).toContainEqual({ path: target, kind: "native" });
				expect(watcher.value).toMatchObject({ dirty: expect.arrayContaining(["@test/a"]) });
			},
			{ timeout: 5_000 },
		);
		applyAndMark(watcher, observer, target);
		explainMarks(root, watcher, observer, target, []);
		expect(failures).toEqual([]);
		watcher.close();
	});
});

/** The inotify watches this process holds (Linux): one line per watch in its inotify descriptors' fdinfo. */
function inotifyWatches(): number {
	let count = 0;
	for (const fd of readdirSync("/proc/self/fdinfo")) {
		try {
			count += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("inotify wd:")).length;
		} catch {
			// Closed meanwhile.
		}
	}
	return count;
}
