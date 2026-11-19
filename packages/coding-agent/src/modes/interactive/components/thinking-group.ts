// Interactive rendering for a consecutive group of assistant thinking sections.
import { Container, Markdown, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { MessageTimestampComponent } from "./message-timestamp.ts";
import type { ThinkingGroup } from "./thinking-groups.ts";

/** Render the collapsed summary or expanded sections for one thinking group. */
export class ThinkingGroupComponent extends Container {
	private group: ThinkingGroup;
	private label: string;
	private hideThinking: boolean;
	private expanded = false;
	private readonly timestamp: MessageTimestampComponent;
	private readonly outputPad: number;

	constructor(group: ThinkingGroup, label: string, hideThinking: boolean, timestamp: number, outputPad = 1) {
		super();
		this.group = group;
		this.label = label;
		this.hideThinking = hideThinking;
		this.timestamp = new MessageTimestampComponent(timestamp);
		this.outputPad = outputPad;
		this.update();
	}

	setLabel(label: string): void {
		this.label = label;
		this.update();
	}

	setGroup(group: ThinkingGroup): void {
		this.group = group;
		this.update();
	}

	setHideThinkingBlock(hide: boolean): void {
		if (this.hideThinking !== hide) this.expanded = false;
		this.hideThinking = hide;
		this.update();
	}

	private update(): void {
		this.clear();
		const label = this.label.trim();
		if (!label) return;
		this.addChild(this.timestamp);
		const hidden = this.hideThinking && !this.expanded;
		const showAll = this.expanded;
		if (hidden || (!this.expanded && this.group.state === "closed")) {
			this.addChild(new Spacer(1));
			this.addChild(
				new MouseRegion(
					new Text(
						theme.italic(theme.fg("thinkingText", `${label} (${this.group.sections.length})`)),
						this.outputPad,
						0,
					),
					(event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.expanded = !this.expanded;
						this.update();
						return { handled: true };
					},
				),
			);
			return;
		}
		if (this.group.state === "open" && this.group.sections.length > 1 && !showAll) {
			this.addSummary(`${label} (${this.group.sections.length - 1} earlier)`);
		}
		const sections = showAll ? this.group.sections : this.group.sections.slice(-1);
		for (const section of sections) {
			this.addChild(new Spacer(1));
			this.addChild(
				new MouseRegion(
					new Markdown(section, this.outputPad, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("thinkingText", text),
						italic: true,
					}),
					(event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.expanded = !this.expanded;
						this.update();
						return { handled: true };
					},
				),
			);
		}
	}

	private addSummary(text: string): void {
		this.addChild(new Spacer(1));
		this.addChild(
			new MouseRegion(new Text(theme.italic(theme.fg("thinkingText", text)), this.outputPad, 0), (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.expanded = !this.expanded;
				this.update();
				return { handled: true };
			}),
		);
	}
}
