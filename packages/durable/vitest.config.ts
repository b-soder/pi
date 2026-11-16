import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const coverage = process.env.PI_COVERAGE_DIR
	? {
			enabled: true,
			provider: "v8" as const,
			include: ["src/**/*.ts"],
			reporter: ["json"],
			reportsDirectory: resolve(process.env.PI_COVERAGE_DIR, "vitest-durable"),
		}
	: {};

const durableSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const durableSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		// Run in workerd by their own config: `npm run test:workers`.
		exclude: [...configDefaults.exclude, "test-workers/**"],
		setupFiles: ["./test/setup-document-retention.ts"],
		coverage,
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-durable$/, replacement: durableSrcIndex },
			{ find: /^@earendil-works\/pi-durable\/testing$/, replacement: durableSrcTesting },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
