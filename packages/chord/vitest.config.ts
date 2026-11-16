// Chord's Node tests use workspace sources and canonical temporary paths.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const coverage = process.env.PI_COVERAGE_DIR
	? {
			enabled: true,
			provider: "v8" as const,
			include: ["src/**/*.ts"],
			reporter: ["json"],
			reportsDirectory: resolve(process.env.PI_COVERAGE_DIR, "vitest-chord"),
		}
	: {};

// Spawned processes and bundles still need built workspace packages.
export default defineConfig({
	test: {
		environment: "node",
		// Fixtures and esbuild must name the same files when macOS's temporary directory is a symlink.
		env: { TMPDIR: realpathSync(tmpdir()) },
		coverage,
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
