import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { ThinkingGroupComponent } from "../src/modes/interactive/components/thinking-group.ts";
import {
	ConversationThinkingTracker,
	type ThinkingGroup,
} from "../src/modes/interactive/components/thinking-groups.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const openGroup: ThinkingGroup = { sections: ["earlier reasoning", "latest reasoning"], state: "open" };
const closedGroup: ThinkingGroup = { sections: ["first reasoning", "second reasoning"], state: "closed" };

function clickText(component: ThinkingGroupComponent, text: string): void {
	const lines = component.render(80).map(stripAnsi);
	const row = lines.findIndex((line) => line.includes(text));
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 2,
		y: row,
		screenX: 2,
		screenY: row,
		width: 80,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		clickCount: 1,
	};
	component.handleMouse(event);
}

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("ThinkingGroupComponent", () => {
	test("shows the earlier summary and latest section for an open group", () => {
		initTheme("dark");
		const rendered = stripAnsi(
			new ThinkingGroupComponent(openGroup, "Thinking...", false, 1_700_000_000_000).render(80).join("\n"),
		);
		expect(rendered).toContain("Thinking... (1 earlier)");
		expect(rendered).toContain("latest reasoning");
		expect(rendered).not.toContain("earlier reasoning");
	});

	test("collapses a closed group to its total section count", () => {
		initTheme("dark");
		const rendered = stripAnsi(
			new ThinkingGroupComponent(closedGroup, "Thinking...", false, 1_700_000_000_000).render(80).join("\n"),
		);
		expect(rendered).toContain("Thinking... (2)");
		expect(rendered).not.toContain("first reasoning");
		expect(rendered).not.toContain("second reasoning");
	});

	test("click toggles the entire group between default and expanded", () => {
		initTheme("dark");
		const component = new ThinkingGroupComponent(closedGroup, "Thinking...", false, 1_700_000_000_000);
		clickText(component, "Thinking... (2)");
		let rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("first reasoning");
		expect(rendered).toContain("second reasoning");
		clickText(component, "first reasoning");
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Thinking... (2)");
		expect(rendered).not.toContain("first reasoning");
	});

	test("hide setting shows a summary, expands on click, and resets click state", () => {
		initTheme("dark");
		const component = new ThinkingGroupComponent(openGroup, "Thinking...", true, 1_700_000_000_000);
		let rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Thinking... (2)");
		clickText(component, "Thinking... (2)");
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("earlier reasoning");
		component.setHideThinkingBlock(false);
		rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Thinking... (1 earlier)");
		expect(rendered).not.toContain("earlier reasoning");
	});

	test("empty label renders no timestamp or spacing", () => {
		initTheme("dark");
		expect(new ThinkingGroupComponent(openGroup, "  ", false, 1_700_000_000_000).render(80)).toEqual([]);
	});

	test("renders one timestamp for the group", () => {
		initTheme("dark");
		const rendered = stripAnsi(
			new ThinkingGroupComponent(openGroup, "Thinking...", false, 1_700_000_000_000).render(80).join("\n"),
		);
		expect(rendered.match(/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/g)).toHaveLength(1);
	});

	test("streaming updates replace the latest section in place", () => {
		initTheme("dark");
		const chatContainer = new Container();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatContainer,
			thinkingTracker: new ConversationThinkingTracker(),
			thinkingGroupComponents: new Map(),
			thinkingMergedMessageComponents: new Set(),
			openThinkingGroup: undefined,
			streamingThinkingSections: 0,
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			toolOutputEnabled: true,
		});
		const update = Reflect.get(InteractiveMode.prototype, "updateStreamingThinking") as (
			this: unknown,
			message: AssistantMessage,
		) => AssistantMessage;
		update.call(mode, createAssistantMessage([{ type: "thinking", thinking: "partial reasoning" }]));
		update.call(mode, createAssistantMessage([{ type: "thinking", thinking: "completed reasoning" }]));
		const rendered = stripAnsi(chatContainer.render(80).join("\n"));
		expect(rendered).toContain("completed reasoning");
		expect(rendered).not.toContain("partial reasoning");
	});

	test("interactive append groups thinking across tool-log-only messages and closes on assistant text", () => {
		initTheme("dark");
		const chatContainer = new Container();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatContainer,
			thinkingTracker: new ConversationThinkingTracker(),
			thinkingGroupComponents: new Map(),
			thinkingMergedMessageComponents: new Set(),
			openThinkingGroup: undefined,
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			toolOutputEnabled: true,
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
		});
		const append = Reflect.get(InteractiveMode.prototype, "addAssistantMessageToChat") as (
			this: unknown,
			message: AssistantMessage,
		) => void;
		append.call(mode, createAssistantMessage([{ type: "thinking", thinking: "first reasoning" }]));
		// Tool calls/results in the separate tool panel do not invoke the conversation append hook.
		append.call(mode, createAssistantMessage([{ type: "thinking", thinking: "latest reasoning" }]));
		let rendered = stripAnsi(chatContainer.render(80).join("\n"));
		expect(rendered).toContain("Thinking... (1 earlier)");
		expect(rendered).toContain("latest reasoning");
		expect(rendered).not.toContain("first reasoning");
		append.call(mode, createAssistantMessage([{ type: "text", text: "answer" }]));
		rendered = stripAnsi(chatContainer.render(80).join("\n"));
		expect(rendered).toContain("Thinking... (2)");
		expect(rendered).toContain("answer");
		expect(rendered).not.toContain("latest reasoning");
	});
});
