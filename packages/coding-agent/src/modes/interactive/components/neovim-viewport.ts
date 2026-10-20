import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	parseKey,
	sliceByColumn,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Decoder, encode } from "@msgpack/msgpack";
import { getBundledInteractiveAssetPath } from "../../../config.ts";

interface Highlight {
	foreground?: number;
	background?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	undercurl?: boolean;
	strikethrough?: boolean;
	reverse?: boolean;
}

interface GridCell {
	text: string;
	highlight: number;
}

interface ModeInfo {
	cursor_shape?: "block" | "horizontal" | "vertical";
	cell_percentage?: number;
	blinkwait?: number;
	blinkon?: number;
	blinkoff?: number;
}

interface RpcMessage {
	readonly type: number;
	readonly id?: number;
	readonly method?: string;
	readonly params?: unknown[];
	readonly error?: unknown;
	readonly result?: unknown;
}

const decoder = new Decoder();
const DEFAULT_CELL: GridCell = { text: " ", highlight: 0 };
const RESET = "\x1b[0m";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

function valueLength(bytes: Uint8Array, offset: number): number | undefined {
	if (offset >= bytes.length) return undefined;
	const head = bytes[offset]!;
	if (head <= 0x7f || head >= 0xe0 || head === 0xc0 || head === 0xc2 || head === 0xc3) return 1;
	if (head >= 0xa0 && head <= 0xbf) return offset + 1 + (head & 0x1f) <= bytes.length ? 1 + (head & 0x1f) : undefined;
	if (head >= 0x90 && head <= 0x9f) return containerLength(bytes, offset, 1, head & 0x0f);
	if (head >= 0x80 && head <= 0x8f) return containerLength(bytes, offset, 1, (head & 0x0f) * 2);
	const sizeBytes =
		head === 0xca || head === 0xce || head === 0xd2
			? 4
			: head === 0xcb || head === 0xcf || head === 0xd3
				? 8
				: head === 0xcc || head === 0xd0
					? 1
					: head === 0xcd || head === 0xd1
						? 2
						: undefined;
	if (sizeBytes !== undefined) return offset + 1 + sizeBytes <= bytes.length ? 1 + sizeBytes : undefined;
	if (head === 0xc4 || head === 0xd9) return lengthPrefixed(bytes, offset, 1, 2);
	if (head === 0xc7) return lengthPrefixed(bytes, offset, 1, 3);
	if (head === 0xc5 || head === 0xda) return lengthPrefixed(bytes, offset, 2, 3);
	if (head === 0xc8) return lengthPrefixed(bytes, offset, 2, 4);
	if (head === 0xc6 || head === 0xdb) return lengthPrefixed(bytes, offset, 4, 5);
	if (head === 0xc9) return lengthPrefixed(bytes, offset, 4, 6);
	if (head === 0xd4) return offset + 3 <= bytes.length ? 3 : undefined;
	if (head === 0xd5) return offset + 4 <= bytes.length ? 4 : undefined;
	if (head === 0xd6) return offset + 6 <= bytes.length ? 6 : undefined;
	if (head === 0xd7) return offset + 10 <= bytes.length ? 10 : undefined;
	if (head === 0xd8) return offset + 18 <= bytes.length ? 18 : undefined;
	if (head === 0xdc || head === 0xde) {
		if (offset + 3 > bytes.length) return undefined;
		return containerLength(
			bytes,
			offset,
			3,
			new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 2).getUint16(0) * (head === 0xde ? 2 : 1),
		);
	}
	if (head === 0xdd || head === 0xdf) {
		if (offset + 5 > bytes.length) return undefined;
		return containerLength(
			bytes,
			offset,
			5,
			new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0) * (head === 0xdf ? 2 : 1),
		);
	}
	return undefined;
}

function lengthPrefixed(
	bytes: Uint8Array,
	offset: number,
	lengthBytes: number,
	headerBytes: number,
): number | undefined {
	if (offset + headerBytes > bytes.length) return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, lengthBytes);
	const size = lengthBytes === 1 ? view.getUint8(0) : lengthBytes === 2 ? view.getUint16(0) : view.getUint32(0);
	const total = headerBytes + size;
	return offset + total <= bytes.length ? total : undefined;
}

function containerLength(bytes: Uint8Array, offset: number, headerBytes: number, count: number): number | undefined {
	let position = offset + headerBytes;
	for (let item = 0; item < count; item++) {
		const length = valueLength(bytes, position);
		if (length === undefined) return undefined;
		position += length;
	}
	return position - offset;
}

function drainMessages(bytes: Uint8Array): { messages: unknown[]; remaining: Uint8Array } {
	const messages: unknown[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const length = valueLength(bytes, offset);
		if (length === undefined) break;
		messages.push(decoder.decode(bytes.subarray(offset, offset + length)));
		offset += length;
	}
	return { messages, remaining: bytes.slice(offset) };
}

function parseRpcMessage(value: unknown): RpcMessage | undefined {
	if (!Array.isArray(value) || typeof value[0] !== "number") return undefined;
	if (value[0] === 0 && typeof value[1] === "number" && typeof value[2] === "string") {
		return { type: 0, id: value[1], method: value[2], params: Array.isArray(value[3]) ? value[3] : [] };
	}
	if (value[0] === 1 && typeof value[1] === "number") {
		return { type: 1, id: value[1], error: value[2], result: value[3] };
	}
	if (value[0] === 2 && typeof value[1] === "string") {
		return { type: 2, method: value[1], params: Array.isArray(value[2]) ? value[2] : [] };
	}
	return undefined;
}

function toNeovimKey(data: string): string {
	const key = parseKey(data);
	if (!key) return data.replaceAll("<", "<LT>");
	const specialKeys: Record<string, string> = {
		backspace: "BS",
		delete: "Del",
		down: "Down",
		end: "End",
		enter: "CR",
		escape: "Esc",
		home: "Home",
		left: "Left",
		pageDown: "PageDown",
		pageUp: "PageUp",
		right: "Right",
		tab: "Tab",
		up: "Up",
	};
	const parts = key.split("+");
	const base = parts.pop()!;
	if (parts.length === 0 && !specialKeys[base]) return data.replaceAll("<", "<LT>");
	const modifiers = parts.map((part) => ({ alt: "A", ctrl: "C", shift: "S", super: "D" })[part] ?? "").join("-");
	return `<${modifiers ? `${modifiers}-` : ""}${specialKeys[base] ?? base}>`;
}

function colorCode(color: unknown, foreground: boolean): string | undefined {
	if (typeof color !== "number" || color < 0) return undefined;
	return `${foreground ? 38 : 48};2;${(color >> 16) & 0xff};${(color >> 8) & 0xff};${color & 0xff}`;
}

function sgrFor(highlight: Highlight | undefined): string {
	if (!highlight) return "";
	const codes: string[] = [];
	const foreground = colorCode(highlight.foreground, true);
	const background = colorCode(highlight.background, false);
	if (foreground) codes.push(foreground);
	if (background) codes.push(background);
	if (highlight.bold) codes.push("1");
	if (highlight.italic) codes.push("3");
	if (highlight.underline) codes.push("4");
	if (highlight.undercurl) codes.push("4:3");
	if (highlight.strikethrough) codes.push("9");
	if (highlight.reverse) codes.push("7");
	return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export interface BufferCursorPosition {
	line: number;
	col: number;
}

function byteColumnToStringColumn(line: string, byteColumn: number): number {
	let bytes = 0;
	let column = 0;
	for (const character of line) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > byteColumn) break;
		bytes += characterBytes;
		column += character.length;
	}
	return column;
}

/** Embedded Neovim linegrid component. */
export class NeovimViewport implements Component, Focusable {
	private readonly tui: TUI;
	private readonly onSubmit: (text: string) => void;
	private readonly onQuit: () => void;
	private readonly onInterrupt: () => void;
	private readonly onDraftChange: (text: string, mode: "i" | "n") => void;
	private readonly onModeChange: (mode: "i" | "n") => void;
	private readonly onCursorChange: (cursor: BufferCursorPosition) => void;
	private readonly initialText: string;
	private readonly initialMode: "i" | "n";
	private bufferUpdate: Promise<void> = Promise.resolve();
	private pendingBufferText: string | undefined;
	private pendingCursorPosition: BufferCursorPosition | undefined;
	private bufferSyncScheduled = false;
	private resizeUpdate: Promise<void> = Promise.resolve();
	private resizePending = false;
	private resizeGeneration = 0;
	private resizeRpcDone = false;
	private resizeFallbackTimer: NodeJS.Timeout | undefined;
	private bufferCursor: BufferCursorPosition = { line: 0, col: 0 };
	private child: ChildProcessWithoutNullStreams | undefined;
	private inputBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
	private pasteBuffer: string | undefined;
	private readonly grids = new Map<number, GridCell[][]>();
	private readonly gridWraps = new Map<number, boolean[]>();
	private readonly highlights = new Map<number, Highlight>();
	private cursor = { grid: 1, row: 0, col: 0, visible: true };
	private cursorMode: ModeInfo = { cursor_shape: "block", cell_percentage: 100 };
	private readonly modeInfo = new Map<number, ModeInfo>();
	private currentMode: "i" | "n" = "n";
	private commandLineMode = false;
	private initializing = true;
	private width = 1;
	private height = 1;
	private currentFocused = false;
	private attached = false;
	private disposed = false;
	private nextRequestId = 1;
	private channelId = 1;
	private readonly pendingRequests = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private text = "";
	private error: string | undefined;
	private stderr = "";
	private readonly resolveReady: () => void;
	private readonly rejectReady: (error: Error) => void;
	private readonly initialHardwareCursor: boolean;
	readonly ready: Promise<void>;

	constructor(
		tui: TUI,
		handlers: {
			onSubmit: (text: string) => void;
			onQuit: () => void;
			onInterrupt?: () => void;
			onDraftChange?: (text: string, mode: "i" | "n") => void;
			onModeChange?: (mode: "i" | "n") => void;
			onCursorChange?: (cursor: BufferCursorPosition) => void;
			initialText?: string;
			initialMode?: "i" | "n";
		},
		args = ["--embed"],
	) {
		this.tui = tui;
		this.onSubmit = handlers.onSubmit;
		this.onQuit = handlers.onQuit;
		this.onInterrupt = handlers.onInterrupt ?? (() => {});
		this.onDraftChange = handlers.onDraftChange ?? (() => {});
		this.onModeChange = handlers.onModeChange ?? (() => {});
		this.onCursorChange = handlers.onCursorChange ?? (() => {});
		this.initialText = handlers.initialText ?? "";
		this.initialMode = handlers.initialMode ?? "n";
		this.text = this.initialText;
		this.currentMode = this.initialMode;
		this.initialHardwareCursor = tui.getShowHardwareCursor();
		let resolveReady!: () => void;
		let rejectReady!: (error: Error) => void;
		this.ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		this.resolveReady = resolveReady;
		this.rejectReady = rejectReady;
		void this.ready.catch(() => {});
		this.start(args);
	}

	setViewportSize(width: number, height: number): void {
		const nextWidth = Math.max(1, Math.floor(width));
		const nextHeight = Math.max(1, Math.floor(height));
		if (nextWidth === this.width && nextHeight === this.height) return;
		this.width = nextWidth;
		this.height = nextHeight;
		// Neovim keeps its command row below the buffer; Pi draws that row in
		// the divider. Resize only after mirrored text arrives, then reveal the
		// logical cursor: expanding a scrolled one-line window otherwise leaves
		// the last pasted line stranded at screen row zero.
		if (this.child && this.attached) {
			this.resizePending = true;
			this.resizeRpcDone = false;
			if (this.resizeFallbackTimer) clearTimeout(this.resizeFallbackTimer);
			const generation = ++this.resizeGeneration;
			this.resizeUpdate = this.resizeUpdate.then(async () => {
				await this.bufferUpdate;
				await this.request("nvim_ui_try_resize", [this.width, this.height + 1]);
				await this.request("nvim_exec_lua", [
					"local view=vim.fn.winsaveview(); view.topline=math.max(1,view.lnum-vim.api.nvim_win_get_height(0)+1); vim.fn.winrestview(view)",
					[],
				]);
			});
			void this.resizeUpdate.then(
				() => {
					if (generation !== this.resizeGeneration || this.disposed) return;
					this.resizeRpcDone = true;
					this.finishResizeIfReady();
					if (this.resizePending) {
						// Never leave the draft in fallback rendering if a custom Neovim
						// configuration reports an unexpected screen cursor position.
						this.resizeFallbackTimer = setTimeout(() => {
							if (generation !== this.resizeGeneration || this.disposed) return;
							this.resizePending = false;
							this.tui.requestRender();
						}, 120);
						this.resizeFallbackTimer.unref();
					}
				},
				(error: unknown) => this.fail(error),
			);
		}
	}

	getText(): string {
		return this.text;
	}

	getSelectionJoinerAfterRow(row: number, _width: number): string | undefined {
		return this.gridWraps.get(1)?.[row] ? "" : undefined;
	}

	/** Visible buffer rows; the command row occupies the divider below the panel. */
	getNaturalHeight(width: number, terminalRows: number): number {
		const columns = Math.max(1, Math.floor(width));
		const rows = this.text
			.split("\n")
			.reduce((count, line) => count + Math.max(1, Math.ceil((visibleWidth(line) + 1) / columns)), 0);
		return Math.max(1, Math.min(rows, Math.max(5, Math.floor(terminalRows * 0.3)) - 1));
	}

	async getBufferLines(): Promise<string[]> {
		await this.ready;
		await this.bufferUpdate;
		const lines = await this.request("nvim_buf_get_lines", [0, 0, -1, true]);
		if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) {
			throw new Error("Neovim returned invalid buffer lines");
		}
		return lines;
	}

	async getMode(): Promise<string> {
		await this.ready;
		const mode = await this.request("nvim_get_mode", []);
		if (!isRecord(mode) || typeof mode.mode !== "string") throw new Error("Neovim returned an invalid mode");
		return mode.mode;
	}

	async getCursorPosition(): Promise<BufferCursorPosition> {
		await this.ready;
		await this.bufferUpdate;
		const cursor = await this.request("nvim_win_get_cursor", [0]);
		if (!Array.isArray(cursor) || typeof cursor[0] !== "number" || typeof cursor[1] !== "number") {
			throw new Error("Neovim returned an invalid cursor position");
		}
		const lines = await this.getBufferLines();
		const line = Math.max(0, Math.min(lines.length - 1, cursor[0] - 1));
		return { line, col: byteColumnToStringColumn(lines[line] ?? "", cursor[1]) };
	}

	async setCursorPosition(position: BufferCursorPosition): Promise<void> {
		this.pendingCursorPosition = { ...position };
		await this.scheduleBufferSync();
	}

	setText(text: string): void {
		void this.replaceBuffer(text).catch((error: unknown) => this.fail(error));
	}

	async replaceBuffer(text: string): Promise<void> {
		// Only the newest pending mirror snapshot matters while Neovim is processing a write.
		this.text = text;
		this.pendingBufferText = text;
		await this.scheduleBufferSync();
	}

	private scheduleBufferSync(): Promise<void> {
		if (this.bufferSyncScheduled) return this.bufferUpdate;
		this.bufferSyncScheduled = true;
		const update = this.bufferUpdate.then(async () => {
			await this.ready;
			while (this.pendingBufferText !== undefined || this.pendingCursorPosition !== undefined) {
				if (this.pendingBufferText !== undefined) {
					const text = this.pendingBufferText;
					this.pendingBufferText = undefined;
					await this.request("nvim_buf_set_lines", [0, 0, -1, true, text.split("\n")]);
					continue;
				}
				const position = this.pendingCursorPosition;
				this.pendingCursorPosition = undefined;
				if (!position) continue;
				const lines = this.text.split("\n");
				const line = Math.max(0, Math.min(lines.length - 1, Math.floor(position.line)));
				const text = lines[line] ?? "";
				const column = Math.max(0, Math.min(text.length, Math.floor(position.col)));
				const byteColumn = Buffer.byteLength(text.slice(0, column), "utf8");
				await this.request("nvim_win_set_cursor", [0, [line + 1, byteColumn]]);
			}
		});
		this.bufferUpdate = update;
		void update.then(
			() => {
				this.bufferSyncScheduled = false;
				if (this.pendingBufferText !== undefined || this.pendingCursorPosition !== undefined) {
					void this.scheduleBufferSync().catch((error: unknown) => this.fail(error));
				}
			},
			() => {
				this.bufferSyncScheduled = false;
				this.pendingBufferText = undefined;
				this.pendingCursorPosition = undefined;
			},
		);
		return update;
	}

	async restoreState(text: string, mode: "i" | "n"): Promise<void> {
		await this.ready;
		if (this.text !== text) await this.replaceBuffer(text);
		const actualMode = await this.getMode();
		if (mode === "i" && !actualMode.startsWith("i")) await this.request("nvim_input", ["i"]);
		else if (mode === "n" && actualMode.startsWith("i")) await this.request("nvim_input", ["\x1b"]);
		this.currentMode = mode;
		this.onModeChange(mode);
	}

	handleInput(data: string): void {
		if (!this.child || !this.attached || this.disposed) return;
		if (this.pasteBuffer !== undefined) {
			this.pasteBuffer += data;
			this.flushBracketedPaste();
			return;
		}
		const pasteStart = data.indexOf(BRACKETED_PASTE_START);
		if (pasteStart !== -1) {
			const beforePaste = data.slice(0, pasteStart);
			if (beforePaste) this.handleInput(beforePaste);
			this.pasteBuffer = data.slice(pasteStart + BRACKETED_PASTE_START.length);
			this.flushBracketedPaste();
			return;
		}
		// The command row is redrawn before Neovim moves its grid cursor there.
		// Predict the transition for the first command key so the old buffer
		// cursor does not flash for one frame on `:` (or `/` and `?`).
		if (this.currentMode === "n" && (data === ":" || data === "/" || data === "?")) {
			this.commandLineMode = true;
			this.tui.requestRender();
		}
		this.request("nvim_input", [toNeovimKey(data)]).catch((error: unknown) => this.fail(error));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// Preserve TUI-owned clicks and copy selection; only route wheel input to Neovim.
		if (event.type !== "wheel" || !this.child || !this.attached) return undefined;
		if ("resetTextSelection" in this.tui && typeof this.tui.resetTextSelection === "function") {
			this.tui.resetTextSelection();
			this.tui.requestRender();
		}
		if (event.wheelDelta) {
			const modifiers = `${event.shift ? "S" : ""}${event.ctrl ? "C" : ""}${event.alt ? "A" : ""}`;
			const action = event.wheelDelta < 0 ? "up" : "down";
			this.request("nvim_input_mouse", ["wheel", action, modifiers, 1, event.y, event.x]).catch((error: unknown) =>
				this.fail(error),
			);
		}
		return { handled: true, render: false };
	}

	render(width: number): string[] {
		if (this.error) return [`\x1b[31mNeovim: ${this.error}\x1b[0m`];
		if (!this.child) return ["Starting Neovim..."];
		const grid = this.grids.get(1);
		if (!grid) return ["Waiting for Neovim UI..."];
		if (this.resizePending || grid.length < this.height + 1) return this.renderResizingDraft(width);
		const lines: string[] = [];
		for (let row = 0; row < Math.min(this.height, grid.length); row++)
			lines.push(this.renderGridRow(grid, row, width));
		while (lines.length < Math.min(this.height, grid.length)) lines.push("");
		return lines;
	}

	/** Show the canonical draft until Neovim has redrawn its resized grid. */
	private finishResizeIfReady(): void {
		const expectedRow = Math.min(this.bufferCursor.line, this.height - 1);
		if (!this.resizePending || !this.resizeRpcDone || this.grids.get(1)?.length !== this.height + 1) return;
		if (this.cursor.row !== expectedRow && !this.commandLineMode) return;
		this.resizePending = false;
		if (this.resizeFallbackTimer) clearTimeout(this.resizeFallbackTimer);
		this.resizeFallbackTimer = undefined;
		this.tui.requestRender();
	}

	private renderResizingDraft(width: number): string[] {
		const lines = this.text.split("\n");
		const top = Math.max(0, Math.min(lines.length - this.height, this.bufferCursor.line - this.height + 1));
		return Array.from({ length: this.height }, (_, row) => {
			const lineIndex = top + row;
			const line = lines[lineIndex] ?? "";
			const content = sliceByColumn(line, 0, width, true);
			if (!this.currentFocused || lineIndex !== this.bufferCursor.line) return content;
			const column = Math.max(0, Math.min(this.bufferCursor.col, width));
			return `${sliceByColumn(content, 0, column, true)}${CURSOR_MARKER}${sliceByColumn(content, column, width, true)}`;
		});
	}

	/** The last Neovim UI row is drawn by the divider below this viewport. */
	renderCommandRow(width: number): string | undefined {
		const grid = this.grids.get(1);
		if (!grid || !this.currentFocused) return undefined;
		const cells = grid[this.height];
		if (!cells) return undefined;
		let lastContentColumn = 0;
		for (let col = 0; col < Math.min(width, cells.length); col++) {
			if (cells[col]!.text.trim()) lastContentColumn = col + 1;
		}
		const commandCursor = this.commandLineMode && this.cursor.row !== this.height ? lastContentColumn : undefined;
		if (
			this.cursor.visible &&
			this.cursor.grid === 1 &&
			(this.cursor.row === this.height || commandCursor !== undefined)
		) {
			lastContentColumn = Math.max(lastContentColumn, (commandCursor ?? this.cursor.col) + 1);
		}
		return lastContentColumn
			? this.renderGridRow(grid, this.height, Math.min(width, lastContentColumn), commandCursor)
			: undefined;
	}

	private renderGridRow(grid: GridCell[][], row: number, width: number, commandCursor?: number): string {
		const cells = grid[row];
		if (!cells) return "";
		let line = "";
		for (let col = 0; col < Math.min(width, cells.length); col++) {
			const cell = cells[col]!;
			line += sgrFor(this.highlights.get(cell.highlight)) + cell.text + (cell.highlight ? RESET : "");
		}
		if (
			this.currentFocused &&
			this.cursor.visible &&
			this.cursor.grid === 1 &&
			(commandCursor !== undefined || (row === this.cursor.row && (!this.commandLineMode || row === this.height)))
		) {
			const cursorColumn = Math.max(0, Math.min(commandCursor ?? this.cursor.col, Math.min(width, cells.length)));
			const cursorShape = this.cursorMode.cursor_shape;
			this.tui.setCursorStyle(
				cursorShape === "horizontal" ? "underline" : cursorShape === "vertical" ? "bar" : "block",
			);
			line = `${sliceByColumn(line, 0, cursorColumn, true)}${CURSOR_MARKER}${sliceByColumn(line, cursorColumn, width, true)}`;
		}
		return line;
	}

	invalidate(): void {}

	get focused(): boolean {
		return this.currentFocused;
	}

	set focused(focused: boolean) {
		if (this.currentFocused === focused) return;
		this.currentFocused = focused;
		this.tui.setShowHardwareCursor(focused ? true : this.initialHardwareCursor);
		if (!focused) this.tui.setCursorStyle("block");
		if (this.child && this.attached)
			this.request("nvim_ui_set_focus", [focused]).catch((error: unknown) => this.fail(error));
		this.tui.requestRender();
	}

	dispose(): void {
		this.disposed = true;
		if (this.resizeFallbackTimer) clearTimeout(this.resizeFallbackTimer);
		this.tui.setShowHardwareCursor(this.initialHardwareCursor);
		this.tui.setCursorStyle("block");
		for (const pending of this.pendingRequests.values()) pending.reject(new Error("Neovim viewport disposed"));
		this.pendingRequests.clear();
		if (this.child && !this.child.killed) this.child.kill("SIGTERM");
		this.child = undefined;
	}

	private start(args: string[]): void {
		try {
			const bridgePath = getBundledInteractiveAssetPath("pi-embedded-nvim.lua");
			const bridgeCommand = `lua dofile(${JSON.stringify(bridgePath)})`;
			this.child = spawn(process.env.NVIM ?? "nvim", [...args, "--cmd", bridgeCommand], {
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			this.fail(error);
			return;
		}
		const child = this.child;
		child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = `${this.stderr}${chunk.toString()}`.slice(-2000);
		});
		child.on("error", (error) => this.fail(error));
		child.on("exit", (code, signal) => {
			if (!this.disposed && !this.error) {
				const detail = this.stderr.trim();
				this.fail(new Error(`process exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
			}
		});
		this.notify("nvim_set_client_info", ["pi-neovim-viewport", { major: 0, minor: 1, patch: 0 }, "embedder", {}, {}]);
		this.request("nvim_get_api_info", [])
			.then((result) => {
				if (!Array.isArray(result) || typeof result[0] !== "number")
					throw new Error("Neovim did not return an RPC channel id");
				this.channelId = result[0];
				return this.request("nvim_set_var", ["pi_channel", result[0]]);
			})
			.then(() => this.request("nvim_set_option_value", ["laststatus", 0, { scope: "global" }]))
			.then(() => this.request("nvim_set_option_value", ["cmdheight", 1, { scope: "global" }]))
			// Keep insertion at EOL without a Normal-mode virtual column that leaves `x` past the new EOL.
			.then(() => this.request("nvim_set_option_value", ["virtualedit", "insert", { scope: "global" }]))
			.then(() => this.request("nvim_set_option_value", ["mouse", "a", { scope: "global" }]))
			.then(() =>
				this.request("nvim_ui_attach", [
					this.width,
					this.height + 1,
					{ ext_linegrid: true, ext_hlstate: true, ext_multigrid: false },
				]),
			)
			.then(async () => {
				this.attached = true;
				if (this.initialText) {
					await this.request("nvim_buf_set_lines", [0, 0, -1, true, this.initialText.split("\n")]);
				}
				if (this.initialMode === "i") await this.request("nvim_input", ["i"]);
				this.initializing = false;
				this.currentMode = this.initialMode;
				this.onModeChange(this.initialMode);
				this.resolveReady();
			})
			.catch((error: unknown) => this.fail(error));
		this.tui.requestRender();
	}

	private receive(chunk: Uint8Array): void {
		const bytes = new Uint8Array(this.inputBuffer.length + chunk.length);
		bytes.set(this.inputBuffer);
		bytes.set(chunk, this.inputBuffer.length);
		const drained = drainMessages(bytes);
		this.inputBuffer = drained.remaining;
		for (const value of drained.messages) this.handleMessage(value);
	}

	private handleMessage(value: unknown): void {
		const message = parseRpcMessage(value);
		if (!message) return;
		if (message.type === 1 && message.id !== undefined) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				this.pendingRequests.delete(message.id);
				if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
				else pending.resolve(message.result);
			}
			return;
		}
		if (message.type === 0 && message.id !== undefined) {
			if (message.method === "pi_submit") {
				this.handleSubmit(message.params?.[0]);
				this.child?.stdin.write(encode([1, message.id, null, true]));
			} else if (message.method === "nvim_get_api_info") {
				this.child?.stdin.write(encode([1, message.id, null, [this.channelId, {}]]));
			} else {
				this.child?.stdin.write(encode([1, message.id, [0, "unsupported RPC request"], null]));
			}
			return;
		}
		if (message.type !== 2 || message.method === undefined) return;
		if (message.method === "redraw") {
			for (const event of message.params ?? []) this.handleRedrawEvent(event);
			this.finishResizeIfReady();
		} else if (message.method === "pi_submit") {
			this.handleSubmit(message.params?.[0]);
		} else if (message.method === "pi_draft") {
			this.handleDraft(message.params ?? []);
		} else if (message.method === "pi_cursor") {
			this.handleCursor(message.params?.[0], message.params?.[1]);
		} else if (message.method === "pi_quit") {
			this.onQuit();
		} else if (message.method === "pi_interrupt") {
			this.onInterrupt();
		}
	}

	private handleRedrawEvent(value: unknown): void {
		if (!Array.isArray(value) || typeof value[0] !== "string") return;
		const name = value[0];
		for (const payload of value.slice(1)) {
			if (!Array.isArray(payload)) continue;
			if (name === "grid_resize") this.resizeGrid(payload);
			else if (name === "grid_clear" && typeof payload[0] === "number") {
				const grid = this.grids.get(payload[0]);
				if (grid) {
					this.grids.set(payload[0], this.createGrid(grid[0]?.length ?? this.width, grid.length));
					this.gridWraps.set(payload[0], Array(grid.length).fill(false));
				}
			} else if (name === "grid_line") this.updateGridLine(payload);
			else if (name === "grid_scroll") this.scrollGrid(payload);
			else if (name === "grid_cursor_goto") {
				if (payload.every((part) => typeof part === "number"))
					this.cursor = { grid: payload[0]!, row: payload[1]!, col: payload[2]!, visible: true };
			} else if (name === "hl_attr_define" && typeof payload[0] === "number" && isRecord(payload[1]))
				this.highlights.set(payload[0], payload[1] as Highlight);
			else if (name === "grid_destroy" && typeof payload[0] === "number") {
				this.grids.delete(payload[0]);
				this.gridWraps.delete(payload[0]);
			} else if (name === "mode_info_set") this.updateModeInfo(payload);
			else if (name === "mode_change") this.updateCurrentMode(payload);
		}
		this.tui.requestRender();
	}

	private updateModeInfo(payload: unknown[]): void {
		if (typeof payload[0] !== "boolean" || !Array.isArray(payload[1])) return;
		this.modeInfo.clear();
		for (let index = 0; index < payload[1].length; index++) {
			const info = payload[1][index];
			if (isRecord(info)) this.modeInfo.set(index, info as ModeInfo);
		}
		this.updateCurrentMode([undefined, this.cursorModeIndex]);
	}

	private cursorModeIndex = 0;

	private updateCurrentMode(payload: unknown[]): void {
		if (typeof payload[0] === "string") {
			this.commandLineMode = payload[0].startsWith("cmdline_") && payload[0] !== "cmdline_hide";
			this.cursor.visible = payload[0] !== "cmdline_hide";
			const mode = payload[0].startsWith("i") ? "i" : "n";
			if (this.currentMode !== mode) {
				this.currentMode = mode;
				if (!this.initializing) this.onModeChange(mode);
			}
		}
		if (typeof payload[1] === "number") this.cursorModeIndex = payload[1];
		this.cursorMode = this.modeInfo.get(this.cursorModeIndex) ?? this.cursorMode;
		this.tui.requestRender();
	}

	private handleDraft(params: unknown[]): void {
		const lines = params[0];
		if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return;
		const text = lines.join("\n");
		if (typeof params[1] === "string") {
			const mode = params[1].startsWith("i") ? "i" : "n";
			if (mode !== this.currentMode) {
				this.currentMode = mode;
				this.onModeChange(mode);
			}
		}
		if (text !== this.text && this.currentFocused) {
			this.text = text;
			this.onDraftChange(text, this.currentMode);
		}
		if (this.currentFocused) this.handleCursor(params[2], params[3], lines);
	}

	private handleCursor(cursor: unknown, screen: unknown, lines = this.text.split("\n")): void {
		if (Array.isArray(cursor) && typeof cursor[0] === "number" && typeof cursor[1] === "number") {
			const line = Math.max(0, Math.min(lines.length - 1, cursor[0] - 1));
			this.bufferCursor = { line, col: byteColumnToStringColumn(lines[line] ?? "", cursor[1]) };
			this.onCursorChange(this.bufferCursor);
		}
		if (
			Array.isArray(screen) &&
			typeof screen[0] === "number" &&
			typeof screen[1] === "number" &&
			screen[0] >= 0 &&
			screen[1] >= 0
		) {
			this.cursor = {
				...this.cursor,
				grid: 1,
				row: screen[0],
				col: screen[1],
			};
			this.tui.requestRender();
		}
		this.finishResizeIfReady();
	}

	private resizeGrid(payload: unknown[]): void {
		if (typeof payload[0] !== "number" || typeof payload[1] !== "number" || typeof payload[2] !== "number") return;
		const [, width, height] = payload as [number, number, number];
		this.grids.set(payload[0], this.createGrid(width, height));
		this.gridWraps.set(payload[0], Array(height).fill(false));
	}

	private createGrid(width: number, height: number): GridCell[][] {
		return Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ...DEFAULT_CELL })));
	}

	private updateGridLine(payload: unknown[]): void {
		if (
			typeof payload[0] !== "number" ||
			typeof payload[1] !== "number" ||
			typeof payload[2] !== "number" ||
			!Array.isArray(payload[3])
		)
			return;
		const grid = this.grids.get(payload[0]);
		const line = grid?.[payload[1]];
		if (!line) return;
		let col = payload[2];
		let highlight = 0;
		for (const cellValue of payload[3]) {
			if (!Array.isArray(cellValue) || typeof cellValue[0] !== "string") continue;
			const text = cellValue[0];
			if (typeof cellValue[1] === "number") highlight = cellValue[1];
			const repeat = typeof cellValue[2] === "number" ? cellValue[2] : 1;
			for (let index = 0; index < repeat && col < line.length; index++, col++) line[col] = { text, highlight };
		}
		if (col >= line.length) this.gridWraps.get(payload[0])![payload[1]] = payload[4] === true;
	}

	flush(text: string): void {
		this.text = text;
		this.onSubmit(text);
	}

	private handleSubmit(lines: unknown): void {
		if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return;
		this.text = lines.join("\n");
		this.onSubmit(this.text);
	}

	private scrollGrid(payload: unknown[]): void {
		if (!payload.every((part) => typeof part === "number")) return;
		const [gridId, top, bottom, left, right, rows, cols] = payload as number[];
		const grid = this.grids.get(gridId!);
		if (!grid) return;
		const source = grid.map((line) => line.map((cell) => ({ ...cell })));
		const wraps = this.gridWraps.get(gridId!);
		const sourceWraps = wraps?.slice();
		for (let row = top!; row < bottom!; row++)
			for (let col = left!; col < right!; col++) {
				const sourceRow = row + rows!;
				const sourceCol = col + cols!;
				grid[row]![col] = source[sourceRow]?.[sourceCol]
					? { ...source[sourceRow]![sourceCol]! }
					: { ...DEFAULT_CELL };
			}
		if (wraps && left === 0 && right === grid[0]?.length) {
			for (let row = top!; row < bottom!; row++) wraps[row] = sourceWraps?.[row + rows!] ?? false;
		}
	}

	private flushBracketedPaste(): void {
		if (this.pasteBuffer === undefined) return;
		const end = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (end === -1) return;
		// Match Pi's original editor: macOS terminals can send CR-only pastes.
		// Leaving ^M in Neovim lets the original editor normalize and mirror the
		// text back later, resetting Neovim's cursor to the first pasted line.
		const text = this.pasteBuffer.slice(0, end).replace(/\r\n?/g, "\n");
		const remaining = this.pasteBuffer.slice(end + BRACKETED_PASTE_END.length);
		this.pasteBuffer = undefined;
		this.request("nvim_paste", [text, false, -1]).catch((error: unknown) => this.fail(error));
		if (remaining) this.handleInput(remaining);
	}

	private request(method: string, args: unknown[]): Promise<unknown> {
		if (!this.child || this.child.killed || this.disposed) return Promise.reject(new Error("Neovim is not running"));
		const id = this.nextRequestId++;
		const promise = new Promise<unknown>((resolve, reject) => this.pendingRequests.set(id, { resolve, reject }));
		this.child.stdin.write(encode([0, id, method, args]));
		return promise;
	}

	private notify(method: string, args: unknown[]): void {
		this.child?.stdin.write(encode([2, method, args]));
	}

	private fail(error: unknown): void {
		if (this.disposed) return;
		this.error = error instanceof Error ? error.message : String(error);
		this.rejectReady(new Error(this.error));
		this.child?.kill("SIGTERM");
		this.child = undefined;
		this.attached = false;
		for (const pending of this.pendingRequests.values()) pending.reject(new Error(this.error));
		this.pendingRequests.clear();
		this.tui.requestRender();
	}
}
