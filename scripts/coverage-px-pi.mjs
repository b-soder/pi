#!/usr/bin/env node
// Run the supported isolated package suite with coverage and report only fork-touched production source.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { convert } from "ast-v8-to-istanbul";
import coverageLibrary from "istanbul-lib-coverage";

const { createCoverageMap } = coverageLibrary;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesWithVitestCoverage = ["chord", "coding-agent", "durable"];

/** Selects executable package TypeScript production files changed from the baseline ref. */
export function selectTouchedProductionSources(rows) {
	return rows
		.filter(({ status, path }) => status !== "D" && status !== "R" && /^packages\/[^/]+\/src\/.+\.tsx?$/.test(path))
		.map(({ path }) => path)
		.sort();
}

/** Creates zero-hit V8 coverage for an unreported TypeScript file, retaining its executable denominator. */
export async function zeroCoverageForSource(path, code) {
	const coverage = {
		url: pathToFileURL(path).href,
		functions: [{ functionName: "", isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 0 }] }],
	};
	const converted = await convert({ code, ast: parse(code, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }), coverage });
	return converted[resolve(path)];
}

/** Merges raw process profiles by script URL before converting ranges to Istanbul coverage. */
export async function convertProcessProfiles(
	profiles,
	sourcePaths,
	readSource = (path) => readFileSync(path, "utf8"),
	sourceMaps = {},
) {
	if (profiles.length === 0) return {};
	const merged = mergeProcessCovs(profiles);
	const wanted = new Set(sourcePaths.map((path) => resolve(repositoryRoot, path)));
	const coverageMap = createCoverageMap({});
	for (const script of merged.result) {
		if (!script.url.startsWith("file:")) continue;
		const path = resolve(fileURLToPath(script.url));
		const sourceMap = sourceMaps[script.url];
		if (!wanted.has(path) && !sourceMapTargetsWanted(sourceMap, path, wanted)) continue;
		const code = readSource(path);
		const data = await convert({
			code,
			ast: parse(code, { sourceType: "unambiguous", plugins: ["typescript", "jsx"] }),
			coverage: script,
			...(sourceMap ? { sourceMap } : {}),
		});
		coverageMap.merge(data);
	}
	return Object.fromEntries(coverageMap.files().map((path) => [path, coverageMap.fileCoverageFor(path).data]));
}

function sourceMapTargetsWanted(sourceMap, generatedPath, wanted) {
	if (!sourceMap) return false;
	return sourceMap.sources?.some((source) => wanted.has(resolve(dirname(generatedPath), sourceMap.sourceRoot ?? "", source))) ?? false;
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: repositoryRoot, stdio: "inherit", ...options });
	if (result.error) throw result.error;
	return result.status ?? 1;
}

function readChangedPaths(baseRef) {
	const rows = execFileSync("git", ["diff", "--name-status", `${baseRef}...HEAD`], {
		cwd: repositoryRoot,
		encoding: "utf8",
	}).trim()
		.split("\n")
		.filter(Boolean)
		.map((row) => {
			const [status, path] = row.split("\t");
			return { status: status[0], path };
		});
	return rows;
}

function readCoverageJson(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

async function collectRawProfiles(directory) {
	const profiles = [];
	const sourceMaps = {};
	for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
		const report = JSON.parse(readFileSync(join(directory, name), "utf8"));
		profiles.push(report);
		for (const [url, entry] of Object.entries(report["source-map-cache"] ?? {})) {
			sourceMaps[url] = entry.data ?? entry;
		}
	}
	return { profiles, sourceMaps };
}

export function addedExecutableLinesFromPatch(patch, lineHits) {
	const added = new Set();
	let line = 0;
	for (const entry of patch.split("\n")) {
		const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(entry);
		if (header) { line = Number(header[1]); continue; }
		if (entry.startsWith("+") && !entry.startsWith("+++")) { added.add(line); line++; }
		else if (entry.startsWith(" ")) line++;
	}
	const executable = [...added].filter((number) => lineHits.has(number));
	return {
		covered: executable.filter((number) => lineHits.get(number) > 0).length,
		total: executable.length,
	};
}

function executableAddedLines(path, lineHits, baseRef) {
	const patch = execFileSync("git", ["diff", "--unified=0", baseRef, "--", path], {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	return addedExecutableLinesFromPatch(patch, lineHits);
}

async function summarizeFiles(sourcePaths, coverageMap, baseRef, provenance) {
	return Promise.all(sourcePaths.map(async (sourcePath) => {
		const absolutePath = resolve(repositoryRoot, sourcePath);
		let data = coverageMap[absolutePath];
		if (!data) {
			const code = readFileSync(absolutePath, "utf8");
			// Vitest's include glob normally supplies zero-hit files; raw-only packages may not.
			data = await zeroCoverageForSource(absolutePath, code);
		}
		const summary = summarizeCoverageData(data);
		const lineHits = statementStartLineHits(data);
		const added = executableAddedLines(sourcePath, lineHits, baseRef);
		return {
			path: sourcePath,
			coverageSource: provenance[sourcePath] ?? { line: "zero-filled", branch: "zero-filled" },
			line: summary.line,
			branch: summary.branch,
			authoredAddedExecutableLines: { ...added, pct: added.total ? 100 * added.covered / added.total : null },
		};
	}));
}

function positionIdentity(position) {
	const column = Number.isFinite(position?.column) ? position.column : "end";
	return `${position?.line ?? "unknown"}:${column}`;
}

function locationIdentity(location) {
	return `${positionIdentity(location?.start)}-${positionIdentity(location?.end)}`;
}

function uniqueCoverageEntries(entries, identity) {
	const byIdentity = new Map();
	for (const [id, value] of Object.entries(entries)) {
		const key = identity(value);
		if (byIdentity.has(key)) return undefined;
		byIdentity.set(key, id);
	}
	return byIdentity;
}

function branchGroups(data) {
	const groups = new Map();
	for (const [id, branch] of Object.entries(data.branchMap)) {
		const key = `${branch.type}:${locationIdentity(branch.loc)}`;
		if (groups.has(key)) return undefined;
		const arms = new Map();
		for (const [index, location] of branch.locations.entries()) {
			const arm = locationIdentity(location);
			if (arms.has(arm)) return undefined;
			arms.set(arm, index);
		}
		groups.set(key, { id, arms });
	}
	return groups;
}

/** Checks exact statement/function/branch source identities, independent of Istanbul's numeric IDs. */
export function coverageStructuresMatch(left, right) {
	const statements = uniqueCoverageEntries(left.statementMap, locationIdentity);
	const otherStatements = uniqueCoverageEntries(right.statementMap, locationIdentity);
	const functions = uniqueCoverageEntries(left.fnMap, (fn) => `${fn.name}:${locationIdentity(fn.decl)}:${locationIdentity(fn.loc)}`);
	const otherFunctions = uniqueCoverageEntries(right.fnMap, (fn) => `${fn.name}:${locationIdentity(fn.decl)}:${locationIdentity(fn.loc)}`);
	const branches = branchGroups(left);
	const otherBranches = branchGroups(right);
	if (!statements || !otherStatements || !functions || !otherFunctions || !branches || !otherBranches) return false;
	const sameKeys = (a, b) => a.size === b.size && [...a.keys()].every((key) => b.has(key));
	if (!sameKeys(statements, otherStatements) || !sameKeys(functions, otherFunctions) || !sameKeys(branches, otherBranches)) return false;
	for (const [key, branch] of branches) {
		if (!sameKeys(branch.arms, otherBranches.get(key).arms)) return false;
	}
	return true;
}

export async function includeZeroCoverageFiles(sourcePaths, coverageData, readSource = (path) => readFileSync(path, "utf8")) {
	const coverageMap = createCoverageMap(coverageData);
	for (const sourcePath of sourcePaths) {
		const path = resolve(repositoryRoot, sourcePath);
		if (!coverageMap.data[path]) coverageMap.addFileCoverage(await zeroCoverageForSource(path, readSource(path)));
	}
	return Object.fromEntries(coverageMap.files().map((path) => [path, coverageMap.fileCoverageFor(path).data]));
}

export function statementStartLineHits(data) {
	const hits = new Map();
	for (const [id, location] of Object.entries(data.statementMap)) {
		const line = location.start.line;
		hits.set(line, Math.max(hits.get(line) ?? 0, data.s[id]));
	}
	return hits;
}

export function coverageLineStructuresMatch(left, right) {
	const leftLines = [...new Set(Object.values(left.statementMap).map((location) => location.start.line))].sort((a, b) => a - b);
	const rightLines = [...new Set(Object.values(right.statementMap).map((location) => location.start.line))].sort((a, b) => a - b);
	return JSON.stringify(leftLines) === JSON.stringify(rightLines);
}

export function mergeCoverageLines(left, right) {
	if (!coverageLineStructuresMatch(left, right)) throw new Error("Coverage maps have incompatible executable line sets");
	const s = { ...left.s };
	const rightHits = new Map();
	for (const [id, location] of Object.entries(right.statementMap)) {
		rightHits.set(location.start.line, Math.max(rightHits.get(location.start.line) ?? 0, right.s[id]));
	}
	const mergedLines = new Set();
	for (const [id, location] of Object.entries(left.statementMap)) {
		const line = location.start.line;
		if (mergedLines.has(line)) continue;
		mergedLines.add(line);
		s[id] = Math.max(s[id], rightHits.get(line) ?? 0);
	}
	return { ...left, s };
}

export function mergeCoverageHits(left, right) {
	if (!coverageStructuresMatch(left, right)) throw new Error("Coverage maps have incompatible source structures");
	const rightStatements = uniqueCoverageEntries(right.statementMap, locationIdentity);
	const statementHits = Object.fromEntries(Object.entries(left.statementMap).map(([id, location]) => [
		id,
		Math.max(left.s[id], right.s[rightStatements.get(locationIdentity(location))]),
	]));
	const functionIdentity = (fn) => `${fn.name}:${locationIdentity(fn.decl)}:${locationIdentity(fn.loc)}`;
	const rightFunctions = uniqueCoverageEntries(right.fnMap, functionIdentity);
	const functionHits = Object.fromEntries(Object.entries(left.fnMap).map(([id, fn]) => [
		id,
		Math.max(left.f[id], right.f[rightFunctions.get(functionIdentity(fn))]),
	]));
	const rightGroups = branchGroups(right);
	const branchHits = {};
	for (const [leftId, branch] of Object.entries(left.branchMap)) {
		const key = `${branch.type}:${locationIdentity(branch.loc)}`;
		const rightGroup = rightGroups.get(key);
		const rightHits = right.b[rightGroup.id];
		branchHits[leftId] = branch.locations.map((location, index) => {
			const rightIndex = rightGroup.arms.get(locationIdentity(location));
			return Math.max(left.b[leftId][index], rightHits[rightIndex]);
		});
	}
	return { ...left, s: statementHits, f: functionHits, b: branchHits };
}

export function summarizeCoverageData(data) {
	const fileMap = createCoverageMap({ [data.path]: data });
	const summary = fileMap.fileCoverageFor(data.path).toSummary().toJSON();
	return {
		line: { covered: summary.lines.covered, total: summary.lines.total, pct: summary.lines.total ? summary.lines.pct : null },
		branch: { covered: summary.branches.covered, total: summary.branches.total, pct: summary.branches.total ? summary.branches.pct : null },
	};
}

function sumRows(files) {
	const result = { covered: 0, total: 0, pct: null };
	for (const file of files) { result.covered += file.covered; result.total += file.total; }
	if (result.total) result.pct = 100 * result.covered / result.total;
	return result;
}

function digestFiles(paths) {
	const files = [...new Set(paths)].sort().map((path) => {
		const content = readFileSync(resolve(repositoryRoot, path));
		return { path, sha256: createHash("sha256").update(content).digest("hex") };
	});
	const digest = createHash("sha256");
	for (const file of files) digest.update(`${file.path}\0${file.sha256}\n`);
	return { sha256: digest.digest("hex"), files };
}

function getWorktreeState() {
	const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	});
	const paths = status.split("\n").filter(Boolean).map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
	return { dirty: paths.length > 0, paths };
}

function classifyChangedPath(path, sourcePaths) {
	if (sourcePaths.includes(path)) return "measured-production-source";
	if (/\/(test|tests)\//.test(path) || /\.test\.(ts|tsx|js|mjs)$/.test(path)) return "test-or-test-support";
	if (/\.md$/.test(path)) return "documentation";
	if (/package-lock\.json$/.test(path) || /\/schemas\/.*\.json$/.test(path) || /\/theme\/(dark|light)\.json$/.test(path)) return "lock-schema-or-theme-data";
	if (/\.lua$/.test(path)) return "embedded-runtime-asset";
	if (/package\.json$/.test(path)) return "package-manifest";
	return "other-non-executable-or-generated";
}

async function generateReport(baseRef, outputDirectory, testExit) {
	const rows = readChangedPaths(baseRef);
	const sources = selectTouchedProductionSources(rows);
	const vitestMap = createCoverageMap({});
	for (const pkg of packagesWithVitestCoverage) {
		const reportPath = join(outputDirectory, `vitest-${pkg}`, "coverage-final.json");
		vitestMap.merge(readCoverageJson(reportPath));
	}
	const { profiles: rawProfiles, sourceMaps } = await collectRawProfiles(join(outputDirectory, "v8"));
	const rawMap = await convertProcessProfiles(rawProfiles, sources, undefined, sourceMaps);
	const mergeWarnings = [];
	const provenance = {};
	const combinedCoverage = Object.fromEntries(vitestMap.files().map((path) => [path, vitestMap.fileCoverageFor(path).data]));
	for (const source of sources) {
		if (combinedCoverage[resolve(repositoryRoot, source)]) {
			provenance[source] = { line: "Vitest V8", branch: "Vitest V8" };
		}
	}
	for (const [path, rawData] of Object.entries(rawMap)) {
		const source = relative(repositoryRoot, path);
		const vitestData = combinedCoverage[path];
		if (!vitestData) {
			combinedCoverage[path] = rawData;
			provenance[source] = { line: "Node V8 with AST/source-map remap", branch: "Node V8 with AST/source-map remap" };
		} else if (coverageStructuresMatch(vitestData, rawData)) {
			combinedCoverage[path] = mergeCoverageHits(vitestData, rawData);
			provenance[source] = { line: "Vitest V8 + Node V8", branch: "Vitest V8 + Node V8" };
		} else {
			const warning = {
				path: source,
				rawNode: summarizeCoverageData(rawData),
				retainedVitest: summarizeCoverageData(vitestData),
			};
			if (coverageLineStructuresMatch(vitestData, rawData)) {
				combinedCoverage[path] = mergeCoverageLines(vitestData, rawData);
				provenance[source] = { line: "Vitest V8 + Node V8 by source line", branch: "Vitest V8 only" };
				warning.reason = "Branch maps differ; merged only source-line hits and retained Vitest branch counters.";
			} else {
				provenance[source] = { line: "Vitest V8 only", branch: "Vitest V8 only" };
				warning.reason = "Node and Vitest executable line sets differ; retained the Vitest map without combining counters.";
			}
			mergeWarnings.push(warning);
		}
	}

	const completeCoverage = await includeZeroCoverageFiles(sources, combinedCoverage);
	const files = await summarizeFiles(sources, completeCoverage, baseRef, provenance);
	const packageRows = {};
	for (const file of files) {
		const pkg = file.path.split("/")[1];
		const entry = packageRows[pkg] ??= { line: [], branch: [], authoredAddedExecutableLines: [], files: 0 };
		entry.files++;
		entry.line.push(file.line);
		entry.branch.push(file.branch);
		entry.authoredAddedExecutableLines.push(file.authoredAddedExecutableLines);
	}
	for (const entry of Object.values(packageRows)) {
		for (const key of ["line", "branch", "authoredAddedExecutableLines"]) entry[key] = sumRows(entry[key]);
	}
	const incompatibleRawLine = sumRows(mergeWarnings.map((warning) => warning.rawNode.line));
	const incompatibleRetainedLine = sumRows(mergeWarnings.map((warning) => warning.retainedVitest.line));
	const incompatibleRawBranch = sumRows(mergeWarnings.map((warning) => warning.rawNode.branch));
	const incompatibleRetainedBranch = sumRows(mergeWarnings.map((warning) => warning.retainedVitest.branch));
	const measurementConfigFiles = [
		"package.json",
		"package-lock.json",
		"test.sh",
		"packages/chord/vitest.config.ts",
		"packages/coding-agent/vitest.config.ts",
		"packages/durable/vitest.config.ts",
		"scripts/coverage-px-pi.mjs",
		"scripts/coverage-px-pi.test.mjs",
		"docs/coverage-px-pi.md",
	];
	const report = {
		baseRef,
		baseCommit: execFileSync("git", ["rev-parse", `${baseRef}^{commit}`], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
		head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
		node: process.version,
		npm: execFileSync("npm", ["--version"], { cwd: repositoryRoot, encoding: "utf8" }).trim(),
		vitest: JSON.parse(readFileSync(join(repositoryRoot, "node_modules/vitest/package.json"), "utf8")).version,
		coverageProvider: JSON.parse(readFileSync(join(repositoryRoot, "node_modules/@vitest/coverage-v8/package.json"), "utf8")).version,
		testCommand: "./test.sh with PI_COVERAGE_DIR instrumentation",
		modelData: JSON.parse(readFileSync(join(repositoryRoot, "packages/ai/src/providers/data/.manifest.json"), "utf8")),
		testExit,
		reportGeneratedAt: new Date().toISOString(),
		worktree: getWorktreeState(),
		measuredSourceDigest: digestFiles(sources),
		testInputDigest: digestFiles(rows.filter(({ path }) => classifyChangedPath(path, sources) === "test-or-test-support").map(({ path }) => path)),
		measurementConfigDigest: digestFiles(measurementConfigFiles),
		digestExclusions: ["node_modules/", "packages/*/dist/", "packages/ai/src/providers/data/", "packages/env/daemon/target/"],
		aggregationNotes: {
			line: "Istanbul executable-line identity: OR hit counts by statement start line; added diff lines use the same identity.",
			branch: "Branch hits combine only for exact statement/function/branch locations and arm identities.",
			incompatibleMapWarnings: mergeWarnings.length,
			incompatibleCohort: {
				files: mergeWarnings.length,
				rawNodeLine: incompatibleRawLine,
				retainedVitestLine: incompatibleRetainedLine,
				rawNodeBranch: incompatibleRawBranch,
				retainedVitestBranch: incompatibleRetainedBranch,
				branchAggregate: "Retained per-file branch maps; this is not an exhaustive union of incompatible Node and Vitest branch maps.",
			},
		},
		inventory: rows.map(({ status, path }) => ({ status, path, category: classifyChangedPath(path, sources) })),
		deletedPathCount: rows.filter(({ status }) => status === "D").length,
		mergeWarnings,
		packages: packageRows,
		total: {
			line: sumRows(files.map((file) => file.line)),
			branch: sumRows(files.map((file) => file.branch)),
			authoredAddedExecutableLines: sumRows(files.map((file) => file.authoredAddedExecutableLines)),
		},
		files,
	};
	writeFileSync(join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	return report;
}

function parseArgs(args) {
	const options = { baseRef: "v1.5.2", output: undefined, reportOnly: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--base") options.baseRef = args[++index];
		else if (arg === "--output") options.output = args[++index];
		else if (arg === "--report-only") options.reportOnly = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.baseRef || (options.output && !isAbsolute(options.output))) throw new Error("--output must be an absolute path");
	return options;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const outputDirectory = options.output ?? resolve(tmpdir(), `pi-coverage-px-pi-${Date.now()}`);
	mkdirSync(outputDirectory, { recursive: true });
	if (!options.reportOnly) {
		for (const required of [
			"packages/ai/src/providers/data/.manifest.json",
			"packages/chord/dist/index.js",
			"packages/telemetry/dist/index.js",
			"packages/env/daemon/target/debug/pi-env",
		]) {
			if (!existsSync(join(repositoryRoot, required))) {
				throw new Error(`Missing prepared artifact ${required}; see docs/coverage-px-pi.md for the approved preparation steps.`);
			}
		}
		const testLog = join(outputDirectory, "test.log");
		const exit = run("bash", ["-o", "pipefail", "-c", './test.sh 2>&1 | tee "$1"', "coverage", testLog], {
			env: { ...process.env, PI_COVERAGE_DIR: outputDirectory, PI_COVERAGE_BASE: options.baseRef },
		});
		writeFileSync(join(outputDirectory, "test-exit.json"), `${exit}\n`);
		const report = await generateReport(options.baseRef, outputDirectory, exit);
		console.log(`Coverage report: ${join(outputDirectory, "report.json")}`);
		console.log(JSON.stringify({ testExit: exit, files: report.files.length, packages: report.packages }, null, 2));
		process.exitCode = exit;
		return;
	}
	const testExitPath = join(outputDirectory, "test-exit.json");
	if (!existsSync(testExitPath)) throw new Error("report-only mode requires test-exit.json from a completed coverage run");
	const report = await generateReport(options.baseRef, outputDirectory, Number(readFileSync(testExitPath, "utf8").trim()));
	console.log(JSON.stringify({ files: report.files.length, packages: report.packages }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main().catch((error) => { console.error(error); process.exitCode = 1; });
}
