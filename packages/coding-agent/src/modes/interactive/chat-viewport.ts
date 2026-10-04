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

export interface ChatViewportOptions {
	readonly document: Component;
	readonly activity?: Component;
	readonly dividerStatus?: (width: number) => string | undefined;
	readonly toolOutput?: Component;
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

	constructor(onResize: (delta: number) => void, getStatus?: (width: number) => string | undefined) {
		this.onResize = onResize;
		this.getStatus = getStatus;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const left = "── ";
		const status = this.getStatus?.(Math.max(0, safeWidth - visibleWidth(left) - 1));
		if (!status) return ["─".repeat(safeWidth)];
		const remainder = Math.max(0, safeWidth - visibleWidth(left) - visibleWidth(status) - 1);
		return [`${left}${status} ${"─".repeat(remainder)}`];
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
	private readonly getFooterHeight: (width: number) => number;
	private readonly dividerStatus: DividerStatus | undefined;
	private inputExtraHeight = 0;
	private footerExtraHeight = 0;
	private lastInputHeight = 0;
	private lastFooterHeight = 0;
	private lastTerminalRows: number | undefined;

	constructor(options: {
		panels: readonly Component[];
		dividerStatus?: (width: number) => string | undefined;
		panelMinSizes: readonly number[];
		panelBases: readonly number[];
		panelGrowth: readonly number[];
		getInputHeight: (width: number) => number;
		getFooterHeight: (width: number) => number;
		getTerminalRows: () => number;
		getTerminalColumns: () => number;
	}) {
		super();
		this.panelMinSizes = options.panelMinSizes;
		this.panelBases = options.panelBases;
		this.panelGrowth = options.panelGrowth;
		this.getInputHeight = options.getInputHeight;
		this.getFooterHeight = options.getFooterHeight;
		this.dividerStatus = options.dividerStatus ? new DividerStatus(options.dividerStatus) : undefined;
		this.getTerminalRows = options.getTerminalRows;
		this.getTerminalColumns = options.getTerminalColumns;

		for (let index = 0; index < options.panels.length; index++) {
			this.panelEntryIndexes.push(this.children.length);
			this.addChild(options.panels[index]!, {
				basis: this.panelBases[index],
				grow: 0,
				shrink: index >= 2 ? 0 : 1,
				minSize: this.panelMinSizes[index],
				visible: (viewport: { width: number; height: number }) => {
					this.syncPanelSizes(viewport.width, viewport.height);
					return true;
				},
			});
			if (index < options.panels.length - 1) {
				this.addChild(
					new PanelDivider(
						(delta) => this.resizeDivider(index, delta),
						index === 1 && this.dividerStatus ? (width) => this.dividerStatus!.render(width)[0] : undefined,
					),
					{
						basis: 1,
						grow: 0,
						shrink: 0,
						minSize: 1,
						maxSize: 1,
					},
				);
			}
		}
	}

	private syncPanelSizes(width: number, height: number): void {
		const naturalInputHeight = this.getInputHeight(width);
		const naturalFooterHeight = this.getFooterHeight(width);
		if (!this.panelSizes) {
			const sizes = [...this.panelBases];
			sizes[2] = naturalInputHeight;
			sizes[sizes.length - 1] = naturalFooterHeight;
			this.adjustFlexiblePanelSizes(sizes, height - (sizes.length - 1) - sizes.reduce((sum, size) => sum + size, 0));
			this.panelSizes = sizes;
		} else {
			const inputIndex = 2;
			const footerIndex = this.panelSizes.length - 1;
			const inputChange = naturalInputHeight - this.lastInputHeight;
			const footerChange = naturalFooterHeight - this.lastFooterHeight;
			const rowChange = height - (this.lastTerminalRows ?? height);
			this.panelSizes[1] += rowChange;
			this.panelSizes[inputIndex] = naturalInputHeight + this.inputExtraHeight;
			this.panelSizes[footerIndex] = naturalFooterHeight + this.footerExtraHeight;
			this.adjustFlexiblePanelSizes(this.panelSizes, -inputChange - footerChange);
		}
		this.lastInputHeight = naturalInputHeight;
		this.lastFooterHeight = naturalFooterHeight;
		this.lastTerminalRows = height;
		for (let index = 0; index < this.panelSizes.length; index++) {
			this.entries[this.panelEntryIndexes[index]!]!.basis = this.panelSizes[index]!;
		}
	}

	private adjustFlexiblePanelSizes(sizes: number[], delta: number): void {
		const flexibleIndexes = [0, 1];
		let remaining = delta;
		while (remaining > 0) {
			const totalWeight = flexibleIndexes.reduce((sum, index) => sum + this.panelGrowth[index]!, 0);
			let distributed = 0;
			for (const index of flexibleIndexes) {
				if (remaining <= 0) break;
				const amount = Math.max(1, Math.floor((remaining * this.panelGrowth[index]!) / totalWeight));
				sizes[index] = sizes[index]! + amount;
				remaining -= amount;
				distributed += amount;
			}
			if (distributed === 0) break;
		}
		while (remaining < 0) {
			const available = flexibleIndexes.filter((index) => sizes[index]! > this.panelMinSizes[index]!);
			if (available.length === 0) break;
			const totalWeight = available.reduce((sum, index) => sum + this.panelGrowth[index]!, 0);
			let distributed = 0;
			for (const index of available) {
				if (remaining >= 0) break;
				const amount = Math.min(
					sizes[index]! - this.panelMinSizes[index]!,
					Math.max(1, Math.floor((-remaining * this.panelGrowth[index]!) / totalWeight)),
				);
				sizes[index] = sizes[index]! - amount;
				remaining += amount;
				distributed += amount;
			}
			if (distributed === 0) break;
		}
	}

	private resizeDivider(index: number, delta: number): void {
		this.syncPanelSizes(this.getTerminalColumns(), this.getTerminalRows());
		const sizes = this.panelSizes!;
		const lowerMinimum =
			index + 1 === 2
				? this.getInputHeight(this.getTerminalColumns())
				: index + 1 === sizes.length - 1
					? this.getFooterHeight(this.getTerminalColumns())
					: this.panelMinSizes[index + 1]!;
		const applied = Math.max(
			this.panelMinSizes[index]! - sizes[index]!,
			Math.min(sizes[index + 1]! - lowerMinimum, delta),
		);
		if (applied === 0) return;
		sizes[index] = sizes[index]! + applied;
		sizes[index + 1] = sizes[index + 1]! - applied;
		this.entries[this.panelEntryIndexes[index]!]!.basis = sizes[index];
		this.entries[this.panelEntryIndexes[index + 1]!]!.basis = sizes[index + 1];
		if (index === 1) this.inputExtraHeight -= applied;
		if (index + 1 === sizes.length - 1) this.footerExtraHeight -= applied;
		this.invalidate();
	}
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcriptContent =
		options.fourPanel && options.activity ? new VStack([options.document, options.activity]) : options.document;
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
		const input = new VStack([
			{ component: options.pendingMessages, shrink: 1, minSize: 0 },
			{ component: options.editor, shrink: 1, minSize: 1 },
		]);
		const footer = new VStack([{ component: options.footer, shrink: 1, minSize: 0 }]);
		const root = new ResizablePanelStack({
			panels: [toolOutput, transcript, input, footer],
			dividerStatus: options.dividerStatus,
			panelMinSizes: [3, 3, 1, footer.render(options.getTerminalColumns?.() ?? 80).length],
			panelBases: [
				8,
				12,
				input.render(options.getTerminalColumns?.() ?? 80).length,
				footer.render(options.getTerminalColumns?.() ?? 80).length,
			],
			panelGrowth: [3, 7, 0, 0],
			getInputHeight: (width) => input.render(width).length,
			getFooterHeight: (width) => footer.render(width).length,
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
