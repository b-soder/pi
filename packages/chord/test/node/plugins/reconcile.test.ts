// Deterministic finite-window tests: native callbacks are withheld or delivered explicitly at the filesystem boundary.
import { EventEmitter } from "node:events";
import type * as NodeFs from "node:fs";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash } from "../../../src/node/plugins/base-inputs.ts";
import { WatchReconciler } from "../../../src/node/plugins/reconcile.ts";
import { PluginWatcher } from "../../../src/node/plugins/watcher.ts";
import { Batch } from "../../../src/state/internal.ts";

const boundary = vi.hoisted(() => ({
	register: undefined as ((path: string) => void) | undefined,
	stat: undefined as ((path: string) => NodeFs.BigIntStats | undefined) | undefined,
	listing: undefined as ((path: string) => NodeFs.Dir | undefined) | undefined,
	handles: new Map<string, { closed: boolean; emit: (file: string) => void }>(),
}));

vi.mock("node:fs", async (original) => {
	const fs = await original<typeof NodeFs>();
	return {
		...fs,
		lstatSync: (path: NodeFs.PathLike, options: { bigint?: boolean }) =>
			boundary.stat?.(String(path)) ?? fs.lstatSync(path, options),
		opendirSync: (path: string) => boundary.listing?.(path) ?? fs.opendirSync(path),
		watch: vi.fn((path: string, callback: (event: string, file: string) => void) => {
			boundary.register?.(path);
			const handle = { closed: false, emit: (file: string) => callback("change", file) };
			boundary.handles.set(path, handle);
			return Object.assign(new EventEmitter(), {
				close: () => {
					handle.closed = true;
				},
			});
		}),
	};
});

const roots: string[] = [];
const closers: (() => void)[] = [];

function root(): string {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "chord-reconcile-")));
	roots.push(path);
	return path;
}

function reconciler(path: string) {
	vi.useFakeTimers();
	const changed: string[] = [];
	const diagnostics: unknown[] = [];
	const scan = new WatchReconciler(
		(file) => changed.push(file),
		(error) => diagnostics.push(error),
	);
	closers.push(() => scan.close());
	scan.add(path, { kind: "tree" });
	return { scan, changed, diagnostics };
}

function watcher(path: string) {
	vi.useFakeTimers();
	const diagnostics: unknown[] = [];
	const watched = new PluginWatcher(
		{ roots: [path], base: [], kinds: ["worker"], failed: (error) => diagnostics.push(error) },
		new Batch(() => {}, undefined),
	);
	closers.push(() => watched.close());
	return { watched, diagnostics };
}

afterEach(() => {
	for (const close of closers.splice(0)) close();
	boundary.register = undefined;
	boundary.stat = undefined;
	boundary.listing = undefined;
	boundary.handles.clear();
	vi.useRealTimers();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("finite best-effort watch reconciliation", () => {
	it("recovers dropped early edits, additions, deletions and replacements without repeating unchanged marks", () => {
		const path = root();
		const file = join(path, "file");
		const removed = join(path, "removed");
		writeFileSync(file, "old");
		writeFileSync(removed, "old");
		const { changed, diagnostics } = reconciler(path);
		writeFileSync(file, "longer");
		rmSync(removed);
		writeFileSync(join(path, "new"), "new");
		vi.advanceTimersByTime(250);
		expect(changed.sort()).toEqual([file, removed, join(path, "new")].sort());
		vi.advanceTimersByTime(750);
		expect(changed).toHaveLength(3);
		rmSync(file);
		writeFileSync(file, "longer");
		vi.advanceTimersByTime(2000);
		expect(changed.filter((entry) => entry === file)).toHaveLength(2);
		expect(diagnostics).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops after the window, then a Chord topology change starts another finite window", () => {
		const path = root();
		const file = join(path, "file");
		writeFileSync(file, "old");
		const { scan, changed } = reconciler(path);
		vi.advanceTimersByTime(3100);
		expect(vi.getTimerCount()).toBe(0);
		writeFileSync(file, "not recovered outside the window");
		vi.advanceTimersByTime(10_000);
		expect(changed).toEqual([]);
		scan.restart();
		vi.advanceTimersByTime(3100);
		expect(changed).toEqual([file]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("refreshes a native observation but still finds a later edit", () => {
		const path = root();
		const file = join(path, "file");
		writeFileSync(file, "old");
		const { scan, changed } = reconciler(path);
		writeFileSync(file, "native");
		scan.observe(path, "file");
		vi.advanceTimersByTime(250);
		expect(changed).toEqual([]);
		writeFileSync(file, "later");
		vi.advanceTimersByTime(750);
		expect(changed).toEqual([file]);
	});

	it("budgets scans across turns and cancels an open iterator on close", () => {
		const path = root();
		const { scan, changed } = reconciler(path);
		for (let i = 0; i < 600; i++) writeFileSync(join(path, `${i}`), "new");
		vi.advanceTimersByTime(0);
		expect(changed).toHaveLength(256);
		vi.advanceTimersByTime(10);
		expect(changed).toHaveLength(512);
		scan.close();
		vi.advanceTimersByTime(5000);
		expect(changed).toHaveLength(512);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["symlink", "inode"])(
		"does not resolve child paths through a %s replacement between scan turns",
		(replacement) => {
			const parent = root();
			const path = join(parent, "watched");
			mkdirSync(path);
			const outside = root();
			for (let i = 0; i < 600; i++) writeFileSync(join(path, `${i}`), "old");
			writeFileSync(join(outside, "sentinel"), "outside");
			const { changed, diagnostics } = reconciler(path);
			vi.advanceTimersByTime(0);
			renameSync(path, join(parent, "original"));
			if (replacement === "symlink") symlinkSync(outside, path);
			else {
				mkdirSync(path);
				writeFileSync(join(path, "sentinel"), "replacement");
			}
			const reads: string[] = [];
			boundary.stat = (file) => {
				reads.push(file);
				return undefined;
			};
			vi.advanceTimersByTime(4000);
			expect(changed).toEqual([path]);
			expect(reads.some((file) => file.startsWith(`${path}/`))).toBe(false);
			expect(diagnostics).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("reports EACCES on a child without closing its native watch or another directory's reconciliation", () => {
		const path = root();
		const child = join(path, "denied");
		writeFileSync(child, "old");
		const healthy = join(path, "healthy");
		mkdirSync(healthy);
		const recovered = join(healthy, "file");
		writeFileSync(recovered, "old");
		const { watched, diagnostics } = watcher(path);
		writeFileSync(recovered, "recovered by another directory's scan");
		const marks = vi.spyOn(watched, "mark");
		boundary.stat = (file) => {
			if (file === child) throw Object.assign(new Error("denied"), { code: "EACCES" });
			return undefined;
		};
		vi.advanceTimersByTime(3100);
		expect(diagnostics).toHaveLength(1);
		expect(String(diagnostics[0])).toContain("native watching remains active");
		expect(marks).toHaveBeenCalledWith(recovered);
		const handle = boundary.handles.get(path);
		expect(handle?.closed).toBe(false);
		boundary.stat = undefined;
		handle?.emit("denied");
		expect(marks).toHaveBeenCalledWith(child);
		expect(watched.value).toMatchObject({ set: true });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("limits baseline entries but keeps native event coverage", () => {
		const path = root();
		const file = join(path, "real");
		writeFileSync(file, "original");
		const stat = lstatSync(file, { bigint: true });
		boundary.stat = (file) => (file.startsWith(join(path, "virtual")) ? stat : undefined);
		boundary.listing = (dir) => {
			if (dir !== path) return undefined;
			let index = 0;
			// Synthetic filesystem boundary: exercise the real 100,000-entry limit without creating that many files.
			return {
				readSync: () => (index <= 100_000 ? { name: `virtual${index++}` } : null),
				closeSync: () => {},
			} as unknown as NodeFs.Dir;
		};
		const { watched, diagnostics } = watcher(path);
		expect(diagnostics).toHaveLength(1);
		boundary.stat = undefined;
		boundary.listing = undefined;
		const handle = boundary.handles.get(path);
		expect(handle?.closed).toBe(false);
		handle?.emit("real");
		expect(watched.value).toMatchObject({ set: true });
		vi.advanceTimersByTime(3100);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("base-only directories enumerate and count only tracked files, not unrelated siblings", async () => {
		vi.useFakeTimers();
		const path = root();
		const file = join(path, "entry.ts");
		writeFileSync(file, "old");
		boundary.listing = () => {
			throw new Error("must not enumerate a base-only directory");
		};
		boundary.register = () => writeFileSync(file, "edit inside watch registration");
		const diagnostics: unknown[] = [];
		const watched = new PluginWatcher(
			{ roots: [], base: [], kinds: [], failed: (error) => diagnostics.push(error) },
			new Batch(() => {}, undefined),
		);
		closers.push(() => watched.close());
		const marks = vi.spyOn(watched, "mark");
		await watched.recordBase(new Map([[file, contentHash(Buffer.from("old"))]]));
		vi.advanceTimersByTime(250);
		expect(marks).toHaveBeenCalledExactlyOnceWith(file);
		marks.mockClear();
		writeFileSync(join(path, "sibling.ts"), "not base code");
		vi.advanceTimersByTime(750);
		expect(marks).not.toHaveBeenCalled();
		rmSync(path, { recursive: true });
		vi.advanceTimersByTime(2000);
		expect(marks).toHaveBeenCalledExactlyOnceWith(file);
		expect(diagnostics).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("recovers dropped events across registration and native topology changes with generation fences intact", () => {
		const path = root();
		const plugin = join(path, "p");
		mkdirSync(plugin);
		writeFileSync(join(plugin, "worker.ts"), "old");
		writeFileSync(join(plugin, "package.json"), '{"name":"p"}');
		const { watched, diagnostics } = watcher(path);
		const discovery = {
			plugins: [
				{
					name: "p",
					dir: plugin,
					root: path,
					required: false,
					layout: "directory" as const,
					facets: { worker: join(plugin, "worker.ts") },
					dependencies: [],
					external: [],
				},
			],
			problems: [],
		};
		watched.know(discovery, watched.discoverySnapshot());
		const before = watched.snapshot(["p"]);
		writeFileSync(join(plugin, "worker.ts"), "early edit");
		vi.advanceTimersByTime(3100);
		expect(watched.value).toMatchObject({ dirty: ["p"] });
		watched.applied(["p"], before);
		expect(watched.value).toMatchObject({ dirty: ["p"] });
		watched.applied(["p"], watched.snapshot(["p"]));
		expect(vi.getTimerCount()).toBe(0);
		const nested = join(plugin, "nested");
		mkdirSync(nested);
		// A delivered topology event registers a new subtree and starts a window on all existing directories too.
		boundary.handles.get(plugin)?.emit("nested");
		vi.advanceTimersByTime(0);
		watched.applied(["p"], watched.snapshot(["p"]));
		writeFileSync(join(nested, "new.ts"), "dropped after registration");
		writeFileSync(join(plugin, "worker.ts"), "dropped while shared stream rebuilt");
		const seen = watched.discoverySnapshot();
		writeFileSync(join(path, "new.worker.ts"), "new plugin");
		writeFileSync(join(plugin, "package.json"), '{"name":"p","version":"2"}');
		vi.advanceTimersByTime(3100);
		watched.know(discovery, seen);
		expect(watched.value).toMatchObject({ dirty: ["p"], install: ["p"], set: true });
		expect(watched.needsDiscovery).toBe(true);
		expect(diagnostics).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reopens a window when a base-file handle is registered on an already watched tree directory", async () => {
		const path = root();
		const file = join(path, "entry.ts");
		writeFileSync(file, "original");
		const { watched, diagnostics } = watcher(path);
		vi.advanceTimersByTime(3100);
		expect(vi.getTimerCount()).toBe(0);
		await watched.recordBase(new Map([[file, contentHash(Buffer.from("original"))]]));
		writeFileSync(file, "dropped after duplicate directory registration");
		vi.advanceTimersByTime(3100);
		await vi.waitFor(() => expect(watched.value).toMatchObject({ base: true }));
		expect(diagnostics).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports native registration failure once and closes its reconciliation window", () => {
		const path = root();
		const error = new Error("native watch limit");
		boundary.register = () => {
			throw error;
		};
		const { watched, diagnostics } = watcher(path);
		expect(diagnostics).toEqual([error]);
		writeFileSync(join(path, "new"), "change");
		vi.advanceTimersByTime(4000);
		expect(watched.value).toMatchObject({ set: false });
		expect(diagnostics).toEqual([error]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not traverse child links or ignored directories, and forgets a removed directory", () => {
		const path = root();
		const outside = root();
		writeFileSync(join(outside, "file"), "old");
		symlinkSync(outside, join(path, "link"));
		mkdirSync(join(path, "node_modules"));
		mkdirSync(join(path, ".git"));
		const { scan, changed } = reconciler(path);
		writeFileSync(join(outside, "file"), "new");
		writeFileSync(join(path, "node_modules", "ignored"), "new");
		writeFileSync(join(path, ".git", "HEAD"), "new");
		vi.advanceTimersByTime(250);
		expect(changed).toEqual([]);
		scan.remove(path);
		writeFileSync(join(path, "forgotten"), "new");
		vi.advanceTimersByTime(3100);
		expect(changed).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("can close from a reconciliation callback without re-entering the running iterator", () => {
		vi.useFakeTimers();
		const path = root();
		const diagnostics: unknown[] = [];
		const scan = new WatchReconciler(
			() => scan.close(),
			(error) => diagnostics.push(error),
		);
		closers.push(() => scan.close());
		scan.add(path, { kind: "tree" });
		writeFileSync(join(path, "new"), "change");
		vi.advanceTimersByTime(4000);
		expect(diagnostics).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
