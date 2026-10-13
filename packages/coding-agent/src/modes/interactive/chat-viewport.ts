import {
	type Component,
	Container,
	ScrollView,
	type ScrollViewScrollbar,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type InputPanelMode = "orig" | "nvim" | "both";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly activity?: Component;
	readonly dividerStatus?: (width: number) => string | undefined;
	readonly toolOutput?: Component;
	readonly nvimViewport?: Component;
	readonly getInputMode?: () => InputPanelMode;
	readonly getActiveInputLabel?: () => "orig" | "nvim";
	readonly onNvimViewportLayout?: (width: number, height: number) => void;
	readonly getNvimHeight?: (width: number) => number;
	readonly getNvimCommandLine?: (width: number) => string | undefined;
	readonly fourPanel?: boolean;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
	readonly getTerminalRows?: () => number;
	readonly getTerminalColumns?: () => number;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
	readonly toolOutput?: ScrollView;
}

class DividerStatus {
	private readonly getStatus: (width: number) => string | undefined;
	private readonly value = new Container();
	private readonly cache = new Map<number, string>();

	constructor(getStatus: (width: number) => string | undefined) {
		this.getStatus = getStatus;
	}

	render(width: number): string[] {
		const text = this.getStatus(width);
		if (text === undefined) return [];
		const cached = this.cache.get(width);
		if (cached === text) return this.value.render(width);
		this.cache.set(width, text);
		this.value.clear();
		this.value.addChild({ render: () => [text], invalidate: () => {} });
		return this.value.render(width);
	}

	invalidate(): void {
		this.cache.clear();
		this.value.invalidate();
	}
}

class PanelDivider implements Component {
	private lastY: number | undefined;
	private readonly onResize: (delta: number) => void;
	private readonly getStatus: ((width: number) => string | undefined) | undefined;
	private readonly getCommandLine: ((width: number) => string | undefined) | undefined;
	private readonly getRightLabel: (() => string | undefined) | undefined;

	constructor(
		onResize: (delta: number) => void,
		getStatus?: (width: number) => string | undefined,
		getCommandLine?: (width: number) => string | undefined,
		getRightLabel?: () => string | undefined,
	) {
		this.onResize = onResize;
		this.getStatus = getStatus;
		this.getCommandLine = getCommandLine;
		this.getRightLabel = getRightLabel;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const label = this.getRightLabel?.();
		const suffix = label && visibleWidth(label) + 2 < safeWidth ? ` ${label} ` : "";
		const commandLine = this.getCommandLine?.(safeWidth);
		// An active command and its cursor take precedence over the label when
		// they reach the right end of the divider.
		const right = commandLine && visibleWidth(commandLine) >= safeWidth - visibleWidth(suffix) ? "" : suffix;
		const contentWidth = safeWidth - visibleWidth(right);
		if (commandLine) {
			const remaining = contentWidth - visibleWidth(commandLine);
			return [`${remaining > 0 ? `${commandLine} ${"─".repeat(remaining - 1)}` : commandLine}${right}`];
		}
		const left = "── ";
		const status = this.getStatus?.(Math.max(0, contentWidth - visibleWidth(left) - 1));
		if (!status) return [`${"─".repeat(contentWidth)}${right}`];
		const remainder = Math.max(0, contentWidth - visibleWidth(left) - visibleWidth(status) - 1);
		return [`${left}${status} ${"─".repeat(remainder)}${right}`];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "press" && event.button === "left") {
			this.lastY = event.screenY;
			return { handled: true, capture: true };
		}
		if (event.type === "drag" && this.lastY !== undefined) {
			const delta = event.screenY - this.lastY;
			this.lastY = event.screenY;
			if (delta !== 0) this.onResize(delta);
			return { handled: true };
		}
		if (event.type === "release") {
			this.lastY = undefined;
			return { handled: true, render: false };
		}
		if (event.type === "click") return { handled: true, render: false };
		return undefined;
	}

	invalidate(): void {}
}

class ResizablePanelStack extends VStack {
	private panelSizes: number[] | undefined;
	private readonly panelMinSizes: readonly number[];
	private readonly panelBases: readonly number[];
	private readonly panelGrowth: readonly number[];
	private readonly panelEntryIndexes: number[] = [];
	private readonly getTerminalRows: () => number;
	private readonly getTerminalColumns: () => number;
	private readonly getInputHeight: (width: number) => number;
	private readonly getNvimHeight: ((width: number) => number) | undefined;
	private readonly getNvimCommandLine: ((width: number) => string | undefined) | undefined;
	private readonly onPanelLayout: ((width: number, height: number) => void) | undefined;
	private readonly getFooterHeight: (width: number) => number;
	private readonly dividerStatus: DividerStatus | undefined;
	private readonly getInputMode: () => InputPanelMode;
	private readonly getActiveInputLabel: (() => "orig" | "nvim") | undefined;
	private readonly hasNvimPanel: boolean;
	private inputExtraHeight = 0;
	private nvimExtraHeight = 0;
	private footerExtraHeight = 0;

	constructor(options: {
		panels: readonly Component[];
		dividerStatus?: (width: number) => string | undefined;
		panelMinSizes: readonly number[];
		panelBases: readonly number[];
		panelGrowth: readonly number[];
		getInputHeight: (width: number) => number;
		getNvimHeight?: (width: number) => number;
		getNvimCommandLine?: (width: number) => string | undefined;
		getFooterHeight: (width: number) => number;
		getInputMode?: () => InputPanelMode;
		getActiveInputLabel?: () => "orig" | "nvim";
		onPanelLayout?: (width: number, height: number) => void;
		getTerminalRows: () => number;
		getTerminalColumns: () => number;
	}) {
		super();
		this.panelMinSizes = options.panelMinSizes;
		this.panelBases = options.panelBases;
		this.panelGrowth = options.panelGrowth;
		this.getInputHeight = options.getInputHeight;
		this.getNvimHeight = options.getNvimHeight;
		this.getNvimCommandLine = options.getNvimCommandLine;
		this.onPanelLayout = options.onPanelLayout;
		this.getFooterHeight = options.getFooterHeight;
		this.dividerStatus = options.dividerStatus ? new DividerStatus(options.dividerStatus) : undefined;
		this.getInputMode = options.getInputMode ?? (() => "both");
		this.getActiveInputLabel = options.getActiveInputLabel;
		this.hasNvimPanel = options.panels.length === 5;
		this.getTerminalRows = options.getTerminalRows;
		this.getTerminalColumns = options.getTerminalColumns;

		for (let index = 0; index < options.panels.length; index++) {
			this.panelEntryIndexes.push(this.children.length);
			this.addChild(options.panels[index]!, {
				basis: this.panelBases[index],
				grow: 0,
				shrink: options.panels.length === 5 && index === 2 ? 1 : index >= 2 ? 0 : 1,
				minSize: this.panelMinSizes[index],
				...(options.onPanelLayout && index === 2
					? { onLayout: (width: number, height: number) => options.onPanelLayout?.(width, height) }
					: {}),
				visible: (viewport: { width: number; height: number }) => {
					this.syncPanelSizes(viewport.width, Math.min(viewport.height, this.getTerminalRows()));
					return this.isPanelVisible(index);
				},
			});
			if (index < options.panels.length - 1) {
				this.addChild(
					new PanelDivider(
						(delta) => this.resizeDivider(index, this.getNextVisiblePanel(index), delta),
						this.dividerStatus && this.hasDividerStatus(index)
							? (width) => this.dividerStatus!.render(width)[0]
							: undefined,
						(width) => this.getNvimDividerCommandLine(index, width),
						() => this.getFooterInputLabel(index),
					),
					{
						basis: 1,
						grow: 0,
						shrink: 0,
						minSize: 1,
						maxSize: 1,
						visible: () => this.isDividerVisible(index),
					},
				);
			}
		}
	}

	private getFooterInputLabel(index: number): string | undefined {
		if (!this.hasNvimPanel || index !== (this.getInputMode() === "nvim" ? 2 : 3)) return undefined;
		return this.getActiveInputLabel?.();
	}

	private getNvimDividerCommandLine(index: number, width: number): string | undefined {
		if (!this.hasNvimPanel || this.getInputMode() === "orig") return undefined;
		const commandDivider = this.getInputMode() === "both" ? 3 : 2;
		return index === commandDivider ? this.getNvimCommandLine?.(width) : undefined;
	}

	private isPanelVisible(index: number): boolean {
		const mode = this.getInputMode();
		const inputIndex = this.hasNvimPanel ? 3 : 2;
		const nvimIndex = this.hasNvimPanel ? 2 : -1;
		if (index === inputIndex) return mode !== "nvim";
		if (index === nvimIndex) return mode !== "orig";
		return true;
	}

	private getNextVisiblePanel(index: number): number {
		let next = index + 1;
		while (next < this.panelBases.length && !this.isPanelVisible(next)) next++;
		return next;
	}

	private isDividerVisible(index: number): boolean {
		return this.isPanelVisible(index) && this.getNextVisiblePanel(index) < this.panelBases.length;
	}

	private hasDividerStatus(index: number): boolean {
		if (!this.hasNvimPanel) return index === 1;
		const mode = this.getInputMode();
		return mode === "both" ? index === 2 : index === 1;
	}

	private syncPanelSizes(width: number, height: number): void {
		const naturalInputHeight = this.getInputHeight(width);
		const naturalFooterHeight = this.getFooterHeight(width);
		if (!this.panelSizes) this.panelSizes = [...this.panelBases];

		const inputIndex = this.panelSizes.length - 2;
		const footerIndex = this.panelSizes.length - 1;
		this.panelSizes[inputIndex] = naturalInputHeight + this.inputExtraHeight;
		if (this.hasNvimPanel && this.getNvimHeight) {
			this.panelSizes[2] = Math.max(1, this.getNvimHeight(width) + this.nvimExtraHeight);
		}
		this.panelSizes[footerIndex] = naturalFooterHeight + this.footerExtraHeight;

		const visibleIndexes = this.panelSizes.map((_, index) => index).filter((index) => this.isPanelVisible(index));
		let visibleDividerCount = 0;
		for (const index of visibleIndexes) {
			if (this.getNextVisiblePanel(index) < this.panelSizes.length) visibleDividerCount++;
		}
		const visibleSizes = visibleIndexes.map((index) => this.panelSizes![index]!);
		const usedHeight = visibleSizes.reduce((sum, size) => sum + size, 0) + visibleDividerCount;
		this.adjustFlexiblePanelSizes(visibleSizes, height - usedHeight, visibleIndexes);
		for (let index = 0; index < visibleIndexes.length; index++) {
			this.panelSizes[visibleIndexes[index]!] = visibleSizes[index]!;
		}
		// Lay out the Neovim grid before rendering its child. LayoutNode's
		// onLayout callback runs *after* child.render(), which otherwise paints
		// a larger panel from the previous one-row grid for one frame.
		if (this.hasNvimPanel && this.isPanelVisible(2)) this.onPanelLayout?.(width, this.panelSizes[2]!);

		for (let index = 0; index < this.panelSizes.length; index++) {
			const entry = this.entries[this.panelEntryIndexes[index]!]!;
			entry.basis = this.isPanelVisible(index) ? this.panelSizes[index]! : 0;
			entry.minSize = this.isPanelVisible(index) ? this.panelMinSizes[index]! : 0;
		}
	}

	private adjustFlexiblePanelSizes(
		sizes: number[],
		delta: number,
		panelIndexes: readonly number[] = sizes.map((_, index) => index),
	): void {
		const flexibleIndexes = panelIndexes
			.map((panelIndex, index) => ({ panelIndex, index }))
			.filter(({ panelIndex }) => this.panelGrowth[panelIndex]! > 0);
		let remaining = delta;
		while (remaining > 0) {
			const totalWeight = flexibleIndexes.reduce((sum, { panelIndex }) => sum + this.panelGrowth[panelIndex]!, 0);
			let distributed = 0;
			for (const { panelIndex, index } of flexibleIndexes) {
				if (remaining <= 0) break;
				const amount = Math.max(1, Math.floor((remaining * this.panelGrowth[panelIndex]!) / totalWeight));
				sizes[index] = sizes[index]! + amount;
				remaining -= amount;
				distributed += amount;
			}
			if (distributed === 0) break;
		}
		while (remaining < 0) {
			const available = flexibleIndexes.filter(
				({ panelIndex, index }) => sizes[index]! > this.panelMinSizes[panelIndex]!,
			);
			if (available.length === 0) break;
			const totalWeight = available.reduce((sum, { panelIndex }) => sum + this.panelGrowth[panelIndex]!, 0);
			let distributed = 0;
			for (const { panelIndex, index } of available) {
				if (remaining >= 0) break;
				const amount = Math.min(
					sizes[index]! - this.panelMinSizes[panelIndex]!,
					Math.max(1, Math.floor((-remaining * this.panelGrowth[panelIndex]!) / totalWeight)),
				);
				sizes[index] = sizes[index]! - amount;
				remaining += amount;
				distributed += amount;
			}
			if (distributed === 0) break;
		}
	}

	private resizeDivider(index: number, nextIndex: number, delta: number): void {
		this.syncPanelSizes(this.getTerminalColumns(), this.getTerminalRows());
		const sizes = this.panelSizes!;
		const inputIndex = sizes.length - 2;
		const footerIndex = sizes.length - 1;
		const lowerMinimum =
			this.hasNvimPanel && nextIndex === 2 && this.getNvimHeight
				? this.getNvimHeight(this.getTerminalColumns())
				: nextIndex === inputIndex
					? this.getInputHeight(this.getTerminalColumns())
					: nextIndex === footerIndex
						? this.getFooterHeight(this.getTerminalColumns())
						: this.panelMinSizes[nextIndex]!;
		const applied = Math.max(
			this.panelMinSizes[index]! - sizes[index]!,
			Math.min(sizes[nextIndex]! - lowerMinimum, delta),
		);
		if (applied === 0) return;
		sizes[index] = sizes[index]! + applied;
		sizes[nextIndex] = sizes[nextIndex]! - applied;
		this.entries[this.panelEntryIndexes[index]!]!.basis = sizes[index];
		this.entries[this.panelEntryIndexes[nextIndex]!]!.basis = sizes[nextIndex];
		if (nextIndex === inputIndex) this.inputExtraHeight -= applied;
		if (this.hasNvimPanel && nextIndex === 2) this.nvimExtraHeight -= applied;
		if (this.hasNvimPanel && index === 2) this.nvimExtraHeight += applied;
		if (nextIndex === footerIndex) this.footerExtraHeight -= applied;
		this.invalidate();
	}
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcriptContent = options.fourPanel
		? new VStack([options.document, ...(options.activity ? [options.activity] : []), options.pendingMessages])
		: options.document;
	const transcript = new ScrollView(transcriptContent, {
		follow: "end",
		primary: true,
		overscroll: options.fourPanel ? "contain" : "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	if (options.fourPanel && options.toolOutput) {
		const toolOutput = new ScrollView(options.toolOutput, {
			follow: "end",
			overscroll: "contain",
			scrollbar: options.scrollbar ?? "auto",
			scrollbarTrackStyle: options.scrollbarTrackStyle,
			scrollbarThumbStyle: options.scrollbarThumbStyle,
		});
		const input = new VStack([{ component: options.editor, shrink: 1, minSize: 1 }]);
		const footer = new VStack([{ component: options.footer, shrink: 1, minSize: 0 }]);
		const width = options.getTerminalColumns?.() ?? 80;
		const naturalInputHeight = input.render(width).length;
		const naturalFooterHeight = footer.render(width).length;
		const panels = [toolOutput, transcript, ...(options.nvimViewport ? [options.nvimViewport] : []), input, footer];
		const root = new ResizablePanelStack({
			panels,
			dividerStatus: options.dividerStatus,
			panelMinSizes: [3, 3, ...(options.nvimViewport ? [1] : []), 1, naturalFooterHeight],
			panelBases: [
				8,
				12,
				...(options.nvimViewport ? [options.getNvimHeight?.(width) ?? 5] : []),
				naturalInputHeight,
				naturalFooterHeight,
			],
			panelGrowth: [3, 7, ...(options.nvimViewport ? [0] : []), 0, 0],
			getInputHeight: (width) => input.render(width).length,
			getNvimHeight: options.getNvimHeight,
			getNvimCommandLine: options.getNvimCommandLine,
			getFooterHeight: (width) => footer.render(width).length,
			getInputMode: options.getInputMode,
			getActiveInputLabel: options.getActiveInputLabel,
			onPanelLayout: options.onNvimViewportLayout,
			getTerminalRows: options.getTerminalRows ?? (() => 24),
			getTerminalColumns: options.getTerminalColumns ?? (() => 80),
		});
		return { transcript, toolOutput, root };
	}

	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	return {
		transcript,
		root: new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	};
}
