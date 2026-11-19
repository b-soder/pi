// Coordinates conversation-log appends, assistant thinking groups, and their rendering.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { MessageTimestampComponent } from "./message-timestamp.ts";
import { ThinkingGroupComponent } from "./thinking-group.ts";
import { ConversationThinkingTracker, type ThinkingGroup } from "./thinking-groups.ts";

export interface ConversationLogOptions {
	getHideThinkingBlock(): boolean;
	getHiddenThinkingLabel(): string;
	getOutputPad(): number;
	getToolOutputEnabled(): boolean;
	getMarkdownTheme(): MarkdownTheme;
	getMarkdownTransformers(): readonly MarkdownTransformer[];
}

class ConversationLogContainer extends Container {
	private readonly noteVisibleEntry: () => void;

	constructor(noteVisibleEntry: () => void) {
		super();
		this.noteVisibleEntry = noteVisibleEntry;
	}

	override addChild(component: Component): void {
		if (
			!(component instanceof Spacer) &&
			!(component instanceof MessageTimestampComponent) &&
			!(component instanceof ThinkingGroupComponent) &&
			!(component instanceof AssistantMessageComponent)
		) {
			this.noteVisibleEntry();
		}
		super.addChild(component);
	}
}

/** Owns conversation append classification and the interactive thinking-group state. */
export class ConversationLog {
	readonly container: Container;
	private readonly options: ConversationLogOptions;
	private readonly tracker = new ConversationThinkingTracker();
	private readonly groupComponents = new Map<ThinkingGroup, ThinkingGroupComponent>();
	private readonly mergedMessageComponents = new Set<AssistantMessageComponent>();
	private openGroup: ThinkingGroup | undefined;
	private streamingThinkingSections = 0;
	private streamingComponent: AssistantMessageComponent | undefined;

	constructor(options: ConversationLogOptions) {
		this.options = options;
		this.container = new ConversationLogContainer(() => this.closeThinkingGroup());
	}

	/** Start tracking thinking sections for a new streaming assistant message. */
	startStreamingMessage(component: AssistantMessageComponent): void {
		this.streamingThinkingSections = 0;
		this.streamingComponent = component;
	}

	/** Stop tracking the current streaming component after its final update. */
	finishStreamingMessage(): void {
		this.streamingComponent = undefined;
		this.streamingThinkingSections = 0;
	}

	/** Close the open group when the caller adds a visible entry outside the container hook. */
	closeThinkingGroup(): void {
		if (!this.openGroup) return;
		const closedGroup = this.tracker.noteEntry({ kind: "other" });
		if (closedGroup) this.groupComponents.get(closedGroup)?.setGroup(closedGroup);
		this.openGroup = undefined;
	}

	/** Reset grouping state before rebuilding or clearing the conversation log. */
	reset(): void {
		this.tracker.clear();
		this.groupComponents.clear();
		this.mergedMessageComponents.clear();
		this.openGroup = undefined;
		this.streamingThinkingSections = 0;
		this.streamingComponent = undefined;
	}

	/** Update labels on existing groups when the configured hidden-thinking label changes. */
	setHiddenThinkingLabel(label: string): void {
		for (const component of this.groupComponents.values()) component.setLabel(label);
		for (const component of this.mergedMessageComponents) {
			component.setTimestampDividerEnabled(!label.trim());
		}
	}

	/** Apply the hide-thinking setting and reset per-group click expansion state. */
	setHideThinkingBlock(hide: boolean): void {
		for (const component of this.groupComponents.values()) component.setHideThinkingBlock(hide);
	}

	/** Track live assistant content and remove thinking blocks from its message component. */
	updateStreamingThinking(message: AssistantMessage, component: AssistantMessageComponent): AssistantMessage {
		this.streamingComponent = component;
		const thinkingContents = message.content.filter((content) => content.type === "thinking");
		const sections = thinkingContents.map((content) => content.thinking.trim()).filter(Boolean);
		const joined = sections.join("\n\n");
		if (sections.length === 0) {
			const hasVisibleText = message.content.some(
				(content) => content.type !== "thinking" && content.type !== "toolCall",
			);
			const hasToolCalls = message.content.some((content) => content.type === "toolCall");
			const hasVisibleFailure =
				message.stopReason === "length" ||
				((message.stopReason === "error" || message.stopReason === "aborted") && !hasToolCalls);
			if (hasVisibleText || hasVisibleFailure) this.closeThinkingGroup();
			component.setTimestampDividerEnabled(
				this.streamingThinkingSections === 0 || !this.options.getHiddenThinkingLabel().trim(),
			);
			return message;
		}
		if (this.streamingThinkingSections === 0) this.addThinkingSection(joined, message.timestamp);
		else {
			const group = this.tracker.updateLatestSection(joined);
			if (group) this.groupComponents.get(group)?.setGroup(group);
		}
		this.streamingThinkingSections = sections.length;
		component.setTimestampDividerEnabled(!this.options.getHiddenThinkingLabel().trim());
		this.mergedMessageComponents.add(component);
		const hasVisibleText = message.content.some(
			(content) => content.type !== "thinking" && content.type !== "toolCall",
		);
		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		const hasVisibleFailure =
			message.stopReason === "length" ||
			((message.stopReason === "error" || message.stopReason === "aborted") && !hasToolCalls);
		if (hasVisibleText || hasVisibleFailure) this.closeThinkingGroup();
		return { ...message, content: message.content.filter((content) => content.type !== "thinking") };
	}

	/** Render ordered assistant content as group components and ordinary text-message components. */
	addAssistantMessage(
		message: AssistantMessage,
		options?: { populateHistory?: boolean; messageId?: string; timestamp?: string },
	): void {
		let segment: AssistantMessage["content"] = [];
		let hasThinking = false;
		const flushContent = (last: boolean) => {
			if (segment.length === 0 && !last) return;
			const content = segment;
			segment = [];
			const label = this.options.getHiddenThinkingLabel();
			const component = new AssistantMessageComponent(
				{ ...message, content, stopReason: last ? message.stopReason : "stop" },
				this.options.getHideThinkingBlock(),
				this.options.getMarkdownTheme(),
				label,
				this.options.getOutputPad(),
				this.options.getMarkdownTransformers(),
				options?.messageId,
				options?.timestamp,
			);
			if (hasThinking) {
				component.setTimestampDividerEnabled(!label.trim());
				this.mergedMessageComponents.add(component);
			}
			this.container.addChild(component);
		};
		for (let index = 0; index < message.content.length; index++) {
			const content = message.content[index];
			if (content.type === "thinking") {
				if (segment.length > 0) {
					this.closeThinkingGroup();
					flushContent(false);
				}
				const sections: string[] = [];
				while (index < message.content.length && message.content[index].type === "thinking") {
					const thinking = message.content[index++];
					if (thinking.type === "thinking" && thinking.thinking.trim()) sections.push(thinking.thinking.trim());
				}
				index--;
				if (sections.length > 0) {
					this.addThinkingSection(sections.join("\n\n"), message.timestamp);
					hasThinking = true;
				}
			} else {
				if (content.type === "toolCall" && !this.options.getToolOutputEnabled()) this.closeThinkingGroup();
				else if (content.type === "text" && content.text.trim()) this.closeThinkingGroup();
				segment.push(content);
			}
		}
		const hasToolCalls = message.content.some((content) => content.type === "toolCall");
		if (
			message.stopReason === "length" ||
			((message.stopReason === "error" || message.stopReason === "aborted") && !hasToolCalls)
		) {
			this.closeThinkingGroup();
		}
		flushContent(true);
	}

	private addThinkingSection(section: string, timestamp: number): void {
		const group = this.tracker.noteEntry({ kind: "thinking", sections: [section] });
		if (!group) return;
		this.openGroup = group;
		const existingComponent = this.groupComponents.get(group);
		if (existingComponent) {
			existingComponent.setGroup(group);
			return;
		}
		const component = new ThinkingGroupComponent(
			group,
			this.options.getHiddenThinkingLabel(),
			this.options.getHideThinkingBlock(),
			timestamp,
			this.options.getOutputPad(),
		);
		this.groupComponents.set(group, component);
		this.container.addChild(component);
		if (this.streamingComponent) {
			const groupIndex = this.container.children.indexOf(component);
			const streamIndex = this.container.children.indexOf(this.streamingComponent);
			if (groupIndex > streamIndex) {
				this.container.children.splice(groupIndex, 1);
				this.container.children.splice(streamIndex, 0, component);
			}
		}
	}
}
