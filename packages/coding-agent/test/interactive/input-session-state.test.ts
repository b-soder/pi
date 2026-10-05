import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	deleteInputSessionState,
	getInputSessionStatePath,
	readInputSessionState,
	writeInputSessionState,
} from "../../src/modes/interactive/input-session-state.ts";

let tempDir: string;

afterEach(() => {
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("per-session input state", () => {
	test("atomically saves and restores the draft, panel selection, and Neovim mode", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-input-state-"));
		const sessionFile = join(tempDir, "session.jsonl");
		const statePath = getInputSessionStatePath(sessionFile);
		const state = {
			sessionId: "session-1",
			draft: "draft line\nsecond line",
			inputPanelMode: "both" as const,
			nvimMode: "n" as const,
		};

		writeInputSessionState(statePath, state);

		expect(readInputSessionState(statePath, "session-1")).toEqual(state);
		expect(readInputSessionState(statePath, "different-session")).toBeUndefined();
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ version: 1, ...state });

		deleteInputSessionState(statePath);
		expect(readInputSessionState(statePath, "session-1")).toBeUndefined();
	});

	test("ignores malformed sidecars and invalid state values", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-input-state-"));
		const statePath = getInputSessionStatePath(join(tempDir, "session.jsonl"));
		writeInputSessionState(statePath, {
			sessionId: "session-2",
			draft: "draft",
			inputPanelMode: "orig",
			nvimMode: "i",
		});

		writeFileSync(statePath, JSON.stringify({ version: 1, sessionId: "session-2", draft: 4 }));
		expect(readInputSessionState(statePath, "session-2")).toBeUndefined();
	});
});
