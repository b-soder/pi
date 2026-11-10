// Recover a persistent edit without receiving any native event. Reconciliation only invalidates; it never reloads.
// Run from packages/chord: node --conditions=source test/examples/66-watch-reconciliation.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { WatchReconciler } from "../../src/node/plugins/reconcile.ts";

const root = mkdtempSync(join(tmpdir(), "chord-reconciliation-example-"));
const file = join(root, "worker.ts");
writeFileSync(file, "// original");
const scan = new WatchReconciler(
	(path) => console.log("Recovered invalidation:", path),
	(error) => {
		console.error("Watch failed; build on demand:", error);
		scan.close();
	},
);
try {
	// Production PluginWatcher captures this baseline before calling fs.watch for the directory.
	scan.add(root, { kind: "tree" });
	writeFileSync(file, "// edit made during asynchronous native registration");
	// No native watch is installed here: only the finite registration-window scans can detect this edit.
	await setTimeout(750);
} finally {
	scan.close();
	rmSync(root, { recursive: true, force: true });
}
