import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	addedExecutableLinesFromPatch,
	convertProcessProfiles,
	coverageLineStructuresMatch,
	coverageStructuresMatch,
	mergeCoverageHits,
	mergeCoverageLines,
	includeZeroCoverageFiles,
	selectTouchedProductionSources,
	statementStartLineHits,
	summarizeCoverageData,
	zeroCoverageForSource,
} from "./coverage-px-pi.mjs";

const sourcePath = resolve("packages/tui/src/components/text.ts");
const source = "export function selected(value: boolean): number {\n\tif (value) return 1;\n\treturn 0;\n}\nselected(true);\n";

function permuteCoverageIdsAndBranchArms(data) {
	const remap = (values, prefix, mapValue) => Object.fromEntries(
		Object.entries(values).reverse().map(([id, value], index) => [`${prefix}${index}`, mapValue(value, id)]),
	);
	const statementMap = remap(data.statementMap, "statement-", (value) => value);
	const fnMap = remap(data.fnMap, "function-", (value) => value);
	const branchMap = remap(data.branchMap, "branch-", (value) => ({ ...value, locations: [...value.locations].reverse() }));
	return {
		...data,
		statementMap,
		fnMap,
		branchMap,
		s: remap(data.s, "statement-", (_, id) => 2),
		f: remap(data.f, "function-", (_, id) => 2),
		b: remap(data.b, "branch-", (hits) => [...hits].reverse().map((_, index) => index + 3)),
	};
}

test("selects only added or modified package TypeScript production files", () => {
	const files = selectTouchedProductionSources([
		{ status: "M", path: "packages/tui/src/components/text.ts" },
		{ status: "A", path: "packages/chord/src/node/plugins/reconcile.ts" },
		{ status: "M", path: "packages/tui/test/editor.test.ts" },
		{ status: "M", path: "packages/tui/src/theme.json" },
		{ status: "D", path: "packages/tui/src/deleted.ts" },
		{ status: "M", path: "docs/coverage.md" },
	]);
	assert.deepEqual(files, ["packages/chord/src/node/plugins/reconcile.ts", "packages/tui/src/components/text.ts"]);
});

test("creates a zero-hit executable denominator for unexecuted source", async () => {
	const data = await zeroCoverageForSource(sourcePath, source);
	assert.ok(Object.keys(data.statementMap).length > 0);
	assert.ok(Object.values(data.s).every((count) => count === 0));
	assert.ok(Object.keys(data.branchMap).length > 0);
	assert.ok(Object.values(data.b).flat().every((count) => count === 0));
	const summary = summarizeCoverageData(data);
	assert.equal(summary.line.covered, 0);
	assert.equal(summary.branch.covered, 0);
	const complete = await includeZeroCoverageFiles(["packages/tui/src/components/text.ts"], {}, () => source);
	assert.ok(complete[sourcePath], "the report map must retain a previously absent source file");
	assert.equal(summarizeCoverageData(complete[sourcePath]).line.covered, 0);
});

test("refuses to merge incompatible branch maps", async () => {
	const data = await zeroCoverageForSource(sourcePath, source);
	const changedColumns = structuredClone(data);
	const statement = Object.values(changedColumns.statementMap)[0];
	statement.start.column = statement.start.column + 1;
	assert.equal(coverageStructuresMatch(data, changedColumns), false, "same-line column changes are not compatible branch maps");
	const changedBranchColumn = structuredClone(data);
	const changedBranch = Object.values(changedBranchColumn.branchMap)[0];
	changedBranch.locations[0].start.column++;
	assert.equal(coverageStructuresMatch(data, changedBranchColumn), false, "same-line branch-arm columns must match exactly");
	const changedLines = structuredClone(data);
	const branch = Object.values(changedLines.branchMap)[0];
	branch.locations[0].start.line++;
	assert.equal(coverageStructuresMatch(data, changedLines), false);
	assert.equal(coverageLineStructuresMatch(data, changedLines), true);
	const lineHits = { ...changedLines, s: Object.fromEntries(Object.keys(data.s).map((id) => [id, 1])) };
	const lineMerged = mergeCoverageLines(data, lineHits);
	assert.ok(Object.values(lineMerged.s).some((count) => count > 0));
	assert.deepEqual(lineMerged.b, data.b, "branch outcomes remain from one engine when branch maps differ");
	const repeated = {
		...data,
		s: Object.fromEntries(Object.keys(data.s).map((id) => [id, 2])),
		f: Object.fromEntries(Object.keys(data.f).map((id) => [id, 2])),
		b: Object.fromEntries(Object.entries(data.b).map(([id, hits]) => [id, hits.map(() => 2)])),
	};
	const merged = mergeCoverageHits(data, repeated);
	const before = summarizeCoverageData(data);
	const after = summarizeCoverageData(merged);
	assert.equal(after.line.total, before.line.total);
	assert.equal(after.branch.total, before.branch.total);
	assert.ok(after.line.pct === null || after.line.pct <= 100);
	assert.ok(after.branch.pct === null || after.branch.pct <= 100);
	assert.ok(Object.values(merged.s).every((count) => count === 2));

	const permuted = permuteCoverageIdsAndBranchArms(data);
	assert.equal(coverageStructuresMatch(data, permuted), true);
	const aligned = mergeCoverageHits(data, permuted);
	assert.ok(Object.values(aligned.s).every((count) => count === 2));
	for (const [id, branch] of Object.entries(data.branchMap)) {
		const rightId = Object.keys(permuted.branchMap).find((candidate) =>
			`${permuted.branchMap[candidate].type}:${JSON.stringify(permuted.branchMap[candidate].loc)}` === `${branch.type}:${JSON.stringify(branch.loc)}`);
		assert.ok(rightId);
		assert.deepEqual(aligned.b[id], branch.locations.map((location, index) => {
			const rightIndex = permuted.branchMap[rightId].locations.findIndex((arm) => JSON.stringify(arm) === JSON.stringify(location));
			return Math.max(data.b[id][index], permuted.b[rightId][rightIndex]);
		}));
	}
});

test("added executable diff lines follow Istanbul start-line identity, not statement spans", async () => {
	const code = [
		"if (",
		"\t// Comment within a multiline condition",
		"\ttrue",
		") {",
		"\tact();",
		"}",
	].join("\n");
	const lineHits = statementStartLineHits(await zeroCoverageForSource(sourcePath, code));
	assert.deepEqual([...lineHits.keys()].sort((a, b) => a - b), [1, 5]);
	lineHits.set(1, 1);
	lineHits.set(5, 1);
	const patch = [
		"@@ -0,0 +1,6 @@",
		"+if (",
		"+\t// Comment within a multiline condition",
		"+\ttrue",
		"+)",
		"+\tact();",
		"+}",
	].join("\n");
	assert.deepEqual(addedExecutableLinesFromPatch(patch, lineHits), { covered: 2, total: 2 });
});

test("merges duplicate child-process hits and remaps generated source through its source map", async () => {
	const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-coverage-map-test-"));
	try {
		const generatedPath = join(temporaryDirectory, "generated.js");
		const generated = "export function selected(value) {\nif (value) return 1;\nreturn 0;\n}\nselected(true);\n";
		const url = pathToFileURL(generatedPath).href;
		const scriptCoverage = {
			scriptId: "1",
			url,
			functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: generated.length, count: 1 }] }],
		};
		const profile = { result: [scriptCoverage] };
		const sourceMap = {
			version: 3,
			sources: [sourcePath],
			sourcesContent: [source],
			names: [],
			mappings: "AAAA;AACA;AACA;AACA;AACA",
		};
		const coverage = await convertProcessProfiles(
			[profile, profile],
			["packages/tui/src/components/text.ts"],
			() => generated,
			{ [url]: sourceMap },
		);
		const data = coverage[sourcePath];
		assert.ok(data, "coverage should map generated child output back to the touched TypeScript source");
		const summary = summarizeCoverageData(data);
		assert.ok(summary.line.covered > 0);
		assert.ok(summary.line.pct <= 100);
		assert.ok(summary.branch.pct <= 100);
		assert.ok(Object.values(data.s).some((count) => count > 1), "duplicate process hits are merged");
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});
