import { describe, expect, test } from "vitest";
import { hideObservationalMemoryWorkerSessions } from "../../src/cli/session-picker.ts";
import type { SessionInfo } from "../../src/core/session-manager.ts";

function session(name: string | undefined, id: string): SessionInfo {
	return {
		path: `/sessions/${id}.jsonl`,
		id,
		cwd: "/workspace",
		name,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

describe("resume session picker", () => {
	test("hides named OM workers from final and partial All-session results only", async () => {
		const ordinary = session("my project work", "ordinary");
		const observer = session("om-observer-obs-123", "observer");
		const consolidator = session("om-consolidator-run-456", "consolidator");
		const seenProgress: Array<readonly SessionInfo[] | undefined> = [];
		const allLoader = hideObservationalMemoryWorkerSessions(async (onProgress) => {
			onProgress?.(3, 3, [ordinary, observer, consolidator]);
			return [ordinary, observer, consolidator];
		});

		const result = await allLoader((_loaded, _total, partialSessions) => seenProgress.push(partialSessions));

		expect(result).toEqual([ordinary]);
		expect(seenProgress).toEqual([[ordinary]]);
	});

	test("keeps regular sessions even when their cwd is inside a .memory directory", async () => {
		const ordinary = { ...session(undefined, "ordinary-memory"), cwd: "/workspace/.memory/notes" };
		const allLoader = hideObservationalMemoryWorkerSessions(async () => [ordinary]);

		expect(await allLoader()).toEqual([ordinary]);
	});
});
