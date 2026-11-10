// Finite, best-effort metadata reconciliation around native watch topology changes.
import { type Dir, lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

/** A tree directory's children, or only explicitly tracked base-file names. */
export type ReconcileSelection =
	| { readonly kind: "tree" }
	| { readonly kind: "files"; readonly names: ReadonlySet<string> };

type Directory = {
	readonly identity: string;
	readonly entries: Map<string, string>;
	selection: ReconcileSelection;
};

const LIMIT = 100_000;
const PASSES = [0, 250, 1_000, 3_000];

/** Owns pre-registration snapshots and a finite recovery window; native watching is independent. */
export class WatchReconciler {
	readonly #directories = new Map<string, Directory>();
	readonly #changed: (path: string) => void;
	readonly #diagnostic: (error: unknown) => void;
	#entries = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#sweep: Generator<void> | undefined;
	#closed = false;
	#running = false;
	#epoch = 0;
	#sweepEpoch = 0;
	#start = 0;
	#pass = PASSES.length;

	constructor(changed: (path: string) => void, diagnostic: (error: unknown) => void) {
		this.#changed = changed;
		this.#diagnostic = diagnostic;
	}

	/** Captures the baseline before registration, retaining previous observations for already tracked files. */
	add(path: string, selection: ReconcileSelection): void {
		if (this.#closed) return;
		try {
			if (selection.kind === "files" && selection.names.size > LIMIT) throw new Error("base-file limit exceeded");
			const identity = directoryIdentity(path);
			if (identity === undefined) {
				this.#changed(path);
				return;
			}
			let directory = this.#directories.get(path);
			if (directory === undefined) {
				if (this.#directories.size === LIMIT) throw new Error("directory limit exceeded");
				directory = { identity, entries: new Map(), selection };
				this.#directories.set(path, directory);
			} else {
				if (!this.#current(path, directory)) return;
				directory.selection = selection;
				for (const name of directory.entries.keys()) {
					if (!included(selection, name)) this.#record(directory, name, undefined);
				}
			}
			let visited = 0;
			for (const name of names(path, selection)) {
				if (++visited > LIMIT) throw new Error("baseline entry limit exceeded");
				if (directory.entries.has(name)) continue;
				const signature = fingerprint(join(path, name));
				if (signature !== undefined) this.#record(directory, name, signature);
			}
		} catch (error) {
			this.#skip(path, error);
		}
		this.restart();
	}

	/** Starts four best-effort scans for all registered directories after a Chord topology change. */
	restart(): void {
		if (this.#closed) return;
		this.#epoch++;
		this.#start = Date.now();
		this.#pass = 0;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#running) this.#schedule(0);
	}

	/** Refreshes a native observation without suppressing its invalidation or disabling native watching. */
	observe(path: string, name: string): void {
		const directory = this.#directories.get(path);
		if (directory === undefined || !included(directory.selection, name) || this.#closed) return;
		try {
			if (this.#current(path, directory)) this.#record(directory, name, fingerprint(join(path, name)));
		} catch (error) {
			this.#skip(path, error);
		}
	}

	/** Forgets a removed directory and opens a recovery window for the remaining native handles. */
	remove(path: string): void {
		this.#forget(path);
		this.restart();
	}

	/** Cancels the window, releases its open iterator and drops all snapshots. */
	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (!this.#running) {
			this.#sweep?.return(undefined);
			this.#sweep = undefined;
		}
		this.#directories.clear();
		this.#entries = 0;
	}

	#schedule(delay: number): void {
		if (this.#timer !== undefined || this.#closed || this.#pass === PASSES.length) return;
		this.#timer = setTimeout(() => this.#tick(), delay);
		this.#timer.unref();
	}

	#tick(): void {
		this.#timer = undefined;
		if (this.#sweep === undefined) {
			this.#sweepEpoch = this.#epoch;
			this.#sweep = this.#scan();
		}
		for (let steps = 0; steps < 256; steps++) {
			this.#running = true;
			let done: boolean | undefined;
			try {
				done = this.#sweep.next().done;
			} finally {
				this.#running = false;
			}
			if (this.#closed) {
				this.#sweep.return(undefined);
				this.#sweep = undefined;
				return;
			}
			if (done) {
				this.#sweep = undefined;
				// A topology change during this sweep still needs a complete first pass of its own window.
				if (this.#sweepEpoch === this.#epoch) this.#pass++;
				break;
			}
		}
		this.#schedule(
			this.#sweep === undefined ? Math.max(0, this.#start + (PASSES[this.#pass] ?? 0) - Date.now()) : 10,
		);
	}

	*#scan(): Generator<void> {
		for (const [path, directory] of this.#directories) {
			try {
				if (!this.#current(path, directory)) continue;
				const seen = new Set<string>();
				let visited = 0;
				for (const name of names(path, directory.selection)) {
					// A scan yields between chunks: never resolve child paths through a replaced directory.
					if (!this.#current(path, directory)) break;
					if (++visited > LIMIT) throw new Error("scan entry limit exceeded");
					seen.add(name);
					this.#compare(path, directory, name);
					yield;
				}
				for (const name of directory.entries.keys()) {
					if (!this.#current(path, directory)) break;
					if (!seen.has(name)) this.#compare(path, directory, name);
					yield;
				}
			} catch (error) {
				this.#skip(path, error);
			}
			yield;
		}
	}

	#current(path: string, directory: Directory): boolean {
		if (this.#directories.get(path) !== directory) return false;
		if (directoryIdentity(path) === directory.identity) return true;
		this.#forget(path);
		// No registration or traversal of the replacement: native topology handling owns that decision.
		this.#changed(path);
		return false;
	}

	#compare(path: string, directory: Directory, name: string): void {
		const signature = fingerprint(join(path, name));
		if (signature === directory.entries.get(name)) return;
		this.#record(directory, name, signature);
		this.#changed(join(path, name));
	}

	#record(directory: Directory, name: string, signature: string | undefined): void {
		if (signature === undefined) {
			if (directory.entries.delete(name)) this.#entries--;
		} else {
			if (!directory.entries.has(name)) {
				if (this.#entries === LIMIT) throw new Error("entry limit exceeded");
				this.#entries++;
			}
			directory.entries.set(name, signature);
		}
	}

	#forget(path: string): void {
		const directory = this.#directories.get(path);
		if (directory === undefined) return;
		this.#entries -= directory.entries.size;
		this.#directories.delete(path);
	}

	#skip(path: string, error: unknown): void {
		this.#forget(path);
		this.#diagnostic(
			new Error(`Watch reconciliation skipped ${path}; native watching remains active`, { cause: error }),
		);
	}
}

function directoryIdentity(path: string): string | undefined {
	try {
		const stat = lstatSync(path, { bigint: true });
		return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined;
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

function* names(path: string, selection: ReconcileSelection): Generator<string> {
	if (selection.kind === "files") {
		yield* selection.names;
		return;
	}
	let dir: Dir | undefined;
	try {
		dir = opendirSync(path);
		for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
			if (included(selection, entry.name)) yield entry.name;
		}
	} finally {
		dir?.closeSync();
	}
}

function included(selection: ReconcileSelection, name: string): boolean {
	return selection.kind === "files" ? selection.names.has(name) : name !== "node_modules" && name !== ".git";
}

function fingerprint(path: string): string | undefined {
	try {
		const stat = lstatSync(path, { bigint: true });
		const identity = `${stat.dev}:${stat.ino}:${stat.mode}`;
		return stat.isDirectory() ? identity : `${identity}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

function missing(error: unknown): boolean {
	// Filesystem error boundary: disappearance is a change, other errors only disable this directory's reconciliation.
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}
