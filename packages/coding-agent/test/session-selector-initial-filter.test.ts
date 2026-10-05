import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function makeSession(overrides: Partial<SessionInfo> & { id: string; firstMessage: string }): SessionInfo {
	return {
		path: `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: "/tmp/project",
		name: overrides.name,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: overrides.firstMessage,
		allMessagesText: overrides.allMessagesText ?? overrides.firstMessage,
	};
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function renderText(selector: SessionSelectorComponent): string {
	return selector
		.render(120)
		.join("\n")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

const namedSession = makeSession({ id: "named", name: "Keep this", firstMessage: "named prompt" });
const unnamedSession = makeSession({ id: "unnamed", firstMessage: "test-generated prompt" });
const sessions = [namedSession, unnamedSession];

describe("session selector initial name filter", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("can start with named sessions only and Ctrl+N reveals all sessions", async () => {
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings, initialNameFilter: "named" },
		);
		await flushPromises();

		const namedOnly = renderText(selector);
		expect(namedOnly).toContain("Name: Named");
		expect(namedOnly).toContain("Keep this");
		expect(namedOnly).not.toContain("test-generated prompt");

		selector.getSessionList().handleInput("\x0e");

		const allSessions = renderText(selector);
		expect(allSessions).toContain("Name: All");
		expect(allSessions).toContain("test-generated prompt");
	});

	it("defaults to all sessions when no initial filter is supplied", async () => {
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await flushPromises();

		const output = renderText(selector);
		expect(output).toContain("Name: All");
		expect(output).toContain("test-generated prompt");
	});
});
