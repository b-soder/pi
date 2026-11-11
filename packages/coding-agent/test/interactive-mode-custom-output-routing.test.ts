import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { EntryRenderer, MessageRenderer } from "../src/core/extensions/types.ts";
import { createCustomMessage } from "../src/core/messages.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { CustomEntryComponent } from "../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness } from "./suite/harness.ts";

// Exercise the real rendering methods without starting a terminal or loading live settings.
interface RoutingMode {
	toolOutputEnabled: boolean;
	toolOutputExpanded: boolean;
	chatContainer: Container;
	toolOutputContainer: Container;
	streamingComponent?: Component;
	addMessageToChat(message: AgentMessage): void;
	addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void;
	addToolExecutionComponent(component: Component): void;
	renderSessionEntries(entries: SessionEntry[]): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	getMarkdownThemeWithSettings(): MarkdownTheme;
}

const customTypes = ["px-interaction", "subagent_status", "subagent_result", "px-questioner-log"];
const timestamp = "2026-11-11T00:00:00.000Z";
const content = "Full result\nfirst line\nlast line";

function makeMode(fourPanel: boolean, entryRenderer?: EntryRenderer, messageRenderer?: MessageRenderer): RoutingMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		toolOutputEnabled: fourPanel,
		toolOutputExpanded: true,
		outputPad: 1,
		chatContainer: new Container(),
		toolOutputContainer: new Container(),
		pendingTools: new Map(),
		entriesRenderedByBoundaryCompaction: new Set(),
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() },
		runtimeHost: {
			session: {
				extensionRunner: {
					getMessageRenderer: () => messageRenderer,
					getEntryRenderer: () => entryRenderer,
				},
				settingsManager: { getShowCacheMissNotices: () => false },
			},
		},
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
	}) as RoutingMode;
}

function expectPanel(
	mode: RoutingMode,
	fourPanel: boolean,
	componentClass: typeof CustomMessageComponent | typeof CustomEntryComponent,
): void {
	const target = fourPanel ? mode.toolOutputContainer : mode.chatContainer;
	const other = fourPanel ? mode.chatContainer : mode.toolOutputContainer;
	expect(target.children).toHaveLength(1);
	expect(target.children[0]).toBeInstanceOf(componentClass);
	expect(other.children).toHaveLength(0);
}

beforeAll(() => initTheme("dark"));

describe("InteractiveMode custom output routing", () => {
	for (const fourPanel of [true, false]) {
		describe(fourPanel ? "four-panel" : "fallback", () => {
			it.each(customTypes)(
				"routes live and replayed %s messages without changing their card",
				async (customType) => {
					const details = { result: "complete", nested: { retained: true } };
					const renderer = vi.fn<MessageRenderer>((message) => new Text(String(message.content)));
					const mode = makeMode(fourPanel, undefined, renderer);
					const message = createCustomMessage(customType, content, true, details, timestamp);
					await mode.handleEvent({ type: "message_start", message });
					expectPanel(mode, fourPanel, CustomMessageComponent);
					expect(renderer.mock.calls.at(-1)?.[0]).toBe(message);
					expect(message).toEqual({
						role: "custom",
						customType,
						content,
						display: true,
						details,
						timestamp: Date.parse(timestamp),
					});

					const manager = SessionManager.inMemory();
					manager.appendCustomMessageEntry(customType, content, true, details);
					mode.chatContainer.clear();
					mode.toolOutputContainer.clear();
					mode.renderSessionEntries(manager.getBranch());
					expectPanel(mode, fourPanel, CustomMessageComponent);
					expect(renderer.mock.calls.at(-1)?.[0]).toMatchObject({ customType, content, details, display: true });
				},
			);

			it("routes live and replayed Questioner entries, even while the assistant streams", async () => {
				const renderer = vi.fn<EntryRenderer>((entry) => new Text(String(entry.data)));
				const mode = makeMode(fourPanel, renderer);
				const entry: Extract<SessionEntry, { type: "custom" }> = {
					type: "custom",
					customType: "px-questioner-log",
					data: content,
					id: "question",
					parentId: null,
					timestamp,
				};
				mode.streamingComponent = new Text("streaming");
				mode.chatContainer.addChild(mode.streamingComponent);
				await mode.handleEvent({ type: "entry_appended", entry });
				expect(renderer.mock.calls.at(-1)?.[0]).toBe(entry);
				if (fourPanel) {
					expect(mode.toolOutputContainer.children[0]).toBeInstanceOf(CustomEntryComponent);
					expect(mode.chatContainer.children).toEqual([mode.streamingComponent]);
				} else {
					expect(mode.chatContainer.children[0]).toBeInstanceOf(CustomEntryComponent);
					expect(mode.chatContainer.children[1]).toBe(mode.streamingComponent);
					expect(mode.toolOutputContainer.children).toHaveLength(0);
				}
				mode.streamingComponent = undefined;
				mode.chatContainer.clear();
				mode.toolOutputContainer.clear();
				mode.renderSessionEntries([entry]);
				expectPanel(mode, fourPanel, CustomEntryComponent);
			});

			it("keeps unrelated records in chat and respects hidden messages and empty entries", () => {
				const mode = makeMode(fourPanel, () => undefined);
				mode.addMessageToChat(createCustomMessage("unrelated", content, true, undefined, timestamp));
				expect(mode.chatContainer.children).toHaveLength(1);
				mode.chatContainer.clear();
				for (const customType of customTypes) {
					mode.addMessageToChat(createCustomMessage(customType, content, false, undefined, timestamp));
				}
				mode.addCustomEntryToChat({
					type: "custom",
					customType: "px-questioner-log",
					data: content,
					id: "empty",
					parentId: null,
					timestamp,
				});
				expect(mode.chatContainer.children).toHaveLength(0);
				expect(mode.toolOutputContainer.children).toHaveLength(0);
			});
		});
	}

	it.each([true, false])("keeps routed messages model-visible (four-panel=%s)", async (fourPanel) => {
		const harness = await createHarness();
		const mode = makeMode(fourPanel);
		const unsubscribe = harness.session.subscribe(async (event) => {
			if (event.type === "message_start" && event.message.role === "custom") await mode.handleEvent(event);
		});
		try {
			for (const customType of customTypes) {
				await harness.session.sendCustomMessage({
					customType,
					content,
					display: true,
					details: { retained: true },
				});
			}
			expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(4);
			const stream = harness.session.agent.streamFunction;
			const observed = vi.fn<typeof stream>((model, context, options) => {
				expect(
					context.messages.filter(
						(message) =>
							message.role === "user" &&
							(typeof message.content === "string"
								? message.content === content
								: message.content.some((part) => part.type === "text" && part.text === content)),
					),
				).toHaveLength(4);
				return stream(model, context, options);
			});
			harness.session.agent.streamFunction = observed;
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("continue");
			expect(observed).toHaveBeenCalledOnce();
			const target = fourPanel ? mode.toolOutputContainer : mode.chatContainer;
			expect(target.children.filter((child) => child instanceof CustomMessageComponent)).toHaveLength(4);
		} finally {
			unsubscribe();
			harness.cleanup();
		}
	});
});
