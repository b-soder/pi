import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { MessageTimestampComponent } from "../src/modes/interactive/components/message-timestamp.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const timestamp = new Date(2026, 10, 10, 22, 43, 10).getTime();
const label = "2026-11-10 22:43:10";
const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	stopReason: "stop",
	timestamp,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
};

describe("message timestamp dividers", () => {
	beforeEach(() => initTheme("dark"));

	test("formats local time and centers at the current pane width on every render", () => {
		const divider = new MessageTimestampComponent(timestamp);
		for (const width of [79, 80, 40, 120]) {
			const line = stripAnsi(divider.render(width)[0]);
			expect(line).toHaveLength(width);
			expect(line.indexOf(` ${label} `)).toBe(Math.floor((width - 21) / 2));
		}
		expect(stripAnsi(divider.render(79)[0])).toBe(`${"─".repeat(29)} ${label} ${"─".repeat(29)}`);
		for (const width of [1, 10, 19, 20]) expect(stripAnsi(divider.render(width)[0])).toHaveLength(width);
		expect(divider.render(0)).toEqual([]);
	});

	test("replays assistant timestamps and retains them through streaming and invalidation", () => {
		const component = new AssistantMessageComponent(assistant);
		component.updateContent(assistant, true);
		component.invalidate();
		expect(stripAnsi(component.render(80)[0])).toContain(label);
		expect(stripAnsi(component.render(40)[0])).toHaveLength(40);
	});

	test("user replay uses message time rather than entry or render time; tool results add nothing", () => {
		const context = {
			chatContainer: new Container(),
			outputPad: 1,
			getUserMessageText: () => "hello",
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
		};
		const add = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof context,
			message: AgentMessage,
			options?: { timestamp: string },
		) => void;
		add.call(context, { role: "user", content: "hello", timestamp }, { timestamp: "2000-01-01T00:00:00Z" });
		expect(stripAnsi(context.chatContainer.render(80)[0])).toContain(label);
		const count = context.chatContainer.children.length;
		add.call(context, {
			role: "toolResult",
			toolCallId: "call",
			toolName: "bash",
			content: [],
			isError: false,
			timestamp,
		});
		expect(context.chatContainer.children).toHaveLength(count);
	});
});
