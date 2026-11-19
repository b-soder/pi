import { describe, expect, test } from "vitest";
import {
	type ClassifiedConversationEntry,
	ConversationThinkingTracker,
	groupThinkingEntries,
} from "../src/modes/interactive/components/thinking-groups.ts";

const thinking = (section: string): ClassifiedConversationEntry => ({ kind: "thinking", sections: [section] });
const other: ClassifiedConversationEntry = { kind: "other" };
const tool: ClassifiedConversationEntry = { kind: "tool-log-only" };

describe("thinking group reducer", () => {
	test("keeps one section open", () => {
		expect(groupThinkingEntries([thinking("one")])).toEqual([{ sections: ["one"], state: "open" }]);
	});

	test("joins thinking across tool-log-only entries", () => {
		expect(groupThinkingEntries([thinking("one"), tool, thinking("two")])).toEqual([
			{ sections: ["one", "two"], state: "open" },
		]);
	});

	test("closes on text, user, error, abort, and truncation entries", () => {
		for (const kind of ["text", "user", "error", "abort", "truncation"]) {
			const closure: ClassifiedConversationEntry = { kind: "other" };
			expect(groupThinkingEntries([thinking("one"), closure]), kind).toEqual([
				{ sections: ["one"], state: "closed" },
			]);
		}
	});

	test("inline tool output closes a group when tool output is disabled", () => {
		expect(groupThinkingEntries([thinking("one"), other])).toEqual([{ sections: ["one"], state: "closed" }]);
	});

	test("thinking followed by text adds the thinking before closing it", () => {
		expect(groupThinkingEntries([thinking("reasoning"), other])).toEqual([
			{ sections: ["reasoning"], state: "closed" },
		]);
	});

	test("starts a new group after closure", () => {
		expect(groupThinkingEntries([thinking("one"), other, thinking("two")])).toEqual([
			{ sections: ["one"], state: "closed" },
			{ sections: ["two"], state: "open" },
		]);
	});

	test("ignores empty sections and deterministically replays", () => {
		const entries: ClassifiedConversationEntry[] = [thinking(" "), thinking("one"), tool, thinking("two"), other];
		const replay = groupThinkingEntries(entries);
		expect(groupThinkingEntries(entries)).toEqual(replay);
		expect(replay).toEqual([{ sections: ["one", "two"], state: "closed" }]);
	});

	test("incremental tracker matches replay and can reset", () => {
		const entries = [thinking("one"), tool, thinking("two"), other];
		const tracker = new ConversationThinkingTracker();
		for (const entry of entries) tracker.noteEntry(entry);
		expect(tracker.getGroups()).toEqual(groupThinkingEntries(entries));
		expect(groupThinkingEntries(entries)).toEqual([{ sections: ["one", "two"], state: "closed" }]);
		tracker.clear();
		expect(tracker.noteEntry(thinking("fresh"))).toEqual({ sections: ["fresh"], state: "open" });
	});
});
