import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";
import { Editor } from "../../tui/src/components/editor.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { BORDER_COLOR_ENV } from "../src/modes/interactive/border-color.ts";
import { NeovimViewport } from "../src/modes/interactive/components/neovim-viewport.ts";
import { getInputSessionStatePath, writeInputSessionState } from "../src/modes/interactive/input-session-state.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const hasNeovim = spawnSync(process.env.NVIM ?? "nvim", ["--version"], { stdio: "ignore" }).status === 0;
const piLuaPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../nvim/.config/nvim/lua/custom/pi.lua");

type NvimMock = {
	getText: () => string;
	setText: (text: string) => void;
	setCursorPosition?: (cursor: { line: number; col: number }) => Promise<void>;
};
type EditorMock = {
	getText: () => string;
	setText: (text: string) => void;
	setCursor?: (line: number, col: number) => void;
	getCursor?: () => { line: number; col: number };
};

type InputStateThis = {
	inputSessionDraft: string;
	nvimInputMode: "i" | "n";
	restoringInputState: boolean;
	isBashMode: boolean;
	nvimViewportContainer?: NvimMock;
	editor: EditorMock;
	updateEditorBorderColor: () => void;
	scheduleInputSessionStateSave: () => void;
	defaultEditor: { onSubmit?: (text: string) => void };
	ui: { requestRender: () => void };
	renderer?: { getFocusedComponent: () => unknown };
};

type BorderCommandThis = {
	viewportBorderColor: string | undefined;
	persistedBorderColor: string | null | undefined;
	scheduleInputSessionStateSave: () => void;
	showError: (message: string) => void;
	renderer?: object;
};
type RestoreBorderThis = {
	startupBorderColor: string | undefined;
	viewportBorderColor: string | undefined;
	persistedBorderColor: string | null | undefined;
	inputPanelMode: "orig" | "nvim" | "both";
	inputSessionDraft: string;
	nvimInputMode: "i" | "n";
	restoringInputState: boolean;
	inputSessionStatePath: () => string | undefined;
	sessionManager: { getSessionId: () => string };
	editor: EditorMock;
	isInitialized: false;
	ui: { requestRender: () => void; setFocus: (component: unknown) => void };
};

const prototype = InteractiveMode.prototype as unknown as {
	handleBorderCommand(this: BorderCommandThis, text: string): void;
	restoreInputStateForCurrentSession(this: RestoreBorderThis): void;
	handleOriginalInputChange(this: InputStateThis, text: string): void;
	handleNeovimDraftChange(this: InputStateThis, text: string, mode: "i" | "n"): void;
	submitFromNeovim(this: InputStateThis, text: string): void;
	handleOriginalCursorChange(this: CursorStateThis, cursor: { line: number; col: number }): void;
	handleNeovimCursorChange(this: CursorStateThis, cursor: { line: number; col: number }): void;
	insertClipboardTextAtCursor(this: ClipboardStateThis, text: string): void;
	setInputPanelMode(this: any, mode: "orig" | "nvim"): void;
};

type CursorStateThis = {
	syncingInputCursor: boolean;
	nvimViewportContainer?: NvimMock;
	editor: EditorMock;
	renderer: { getFocusedComponent: () => unknown };
};

type ClipboardStateThis = {
	editor: EditorMock & {
		insertTextAtCursor: (text: string) => void;
	};
	handleOriginalCursorChange: (cursor: { line: number; col: number }) => void;
};

describe("InteractiveMode input state", () => {
	test("restores a saved border override and keeps /border default explicit", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-border-state-"));
		const statePath = getInputSessionStatePath(join(tempDir, "session.jsonl"));
		const previousColor = process.env[BORDER_COLOR_ENV];
		const context: RestoreBorderThis = {
			startupBorderColor: "#112233",
			viewportBorderColor: "#112233",
			persistedBorderColor: undefined,
			inputPanelMode: "orig",
			inputSessionDraft: "",
			nvimInputMode: "n",
			restoringInputState: false,
			inputSessionStatePath: () => statePath,
			sessionManager: { getSessionId: () => "px-session" },
			editor: { getText: () => "", setText: vi.fn() },
			isInitialized: false,
			ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		};

		try {
			writeInputSessionState(statePath, {
				sessionId: "px-session",
				draft: "",
				inputPanelMode: "orig",
				nvimMode: "n",
				borderColor: "#A1B2C3",
			});
			prototype.restoreInputStateForCurrentSession.call(context);
			expect(context.viewportBorderColor).toBe("#A1B2C3");
			expect(process.env[BORDER_COLOR_ENV]).toBe("#A1B2C3");

			writeInputSessionState(statePath, {
				sessionId: "px-session",
				draft: "",
				inputPanelMode: "orig",
				nvimMode: "n",
				borderColor: null,
			});
			prototype.restoreInputStateForCurrentSession.call(context);
			expect(context.viewportBorderColor).toBeUndefined();
			expect(context.persistedBorderColor).toBeNull();
			expect(process.env[BORDER_COLOR_ENV]).toBeUndefined();
		} finally {
			if (previousColor === undefined) delete process.env[BORDER_COLOR_ENV];
			else process.env[BORDER_COLOR_ENV] = previousColor;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("persists /border color and explicit theme-default changes", () => {
		const previousColor = process.env[BORDER_COLOR_ENV];
		const scheduleSave = vi.fn();
		const context: BorderCommandThis = {
			viewportBorderColor: undefined,
			persistedBorderColor: undefined,
			scheduleInputSessionStateSave: scheduleSave,
			showError: vi.fn(),
		};

		try {
			prototype.handleBorderCommand.call(context, "/border #12abef");
			expect(context.viewportBorderColor).toBe("#12ABEF");
			expect(context.persistedBorderColor).toBe("#12ABEF");
			expect(process.env[BORDER_COLOR_ENV]).toBe("#12ABEF");

			prototype.handleBorderCommand.call(context, "/border default");
			expect(context.viewportBorderColor).toBeUndefined();
			expect(context.persistedBorderColor).toBeNull();
			expect(process.env[BORDER_COLOR_ENV]).toBeUndefined();
			expect(scheduleSave).toHaveBeenCalledTimes(2);
		} finally {
			if (previousColor === undefined) delete process.env[BORDER_COLOR_ENV];
			else process.env[BORDER_COLOR_ENV] = previousColor;
		}
	});

	test("syncs original-editor changes into Neovim and schedules persistence", () => {
		const setNvimText = vi.fn();
		const scheduleSave = vi.fn();
		const context = {
			inputSessionDraft: "",
			nvimInputMode: "i" as const,
			restoringInputState: false,
			isBashMode: false,
			nvimViewportContainer: { getText: () => "", setText: setNvimText },
			editor: { getText: () => "draft", setText: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			scheduleInputSessionStateSave: scheduleSave,
			defaultEditor: {},
			ui: { requestRender: vi.fn() },
		};

		prototype.handleOriginalInputChange.call(context, "draft");

		expect(context.inputSessionDraft).toBe("draft");
		expect(setNvimText).toHaveBeenCalledWith("draft");
		expect(scheduleSave).toHaveBeenCalledOnce();
	});

	test("syncs Neovim changes back without an echo loop", () => {
		const nvim = {
			text: "draft",
			getText() {
				return this.text;
			},
			setText: vi.fn(function (this: { text: string }, text: string) {
				this.text = text;
			}),
		};
		const scheduleSave = vi.fn();
		const context: InputStateThis = {
			inputSessionDraft: "",
			nvimInputMode: "i",
			restoringInputState: false,
			isBashMode: false,
			nvimViewportContainer: nvim,
			editor: {
				getText: () => "",
				setText: (text) => {
					prototype.handleOriginalInputChange.call(context, text);
				},
			},
			updateEditorBorderColor: vi.fn(),
			scheduleInputSessionStateSave: scheduleSave,
			defaultEditor: {},
			ui: { requestRender: vi.fn() },
			renderer: { getFocusedComponent: () => nvim },
		};

		prototype.handleNeovimDraftChange.call(context, "draft", "n");

		expect(context.inputSessionDraft).toBe("draft");
		expect(context.nvimInputMode).toBe("n");
		expect(nvim.setText).not.toHaveBeenCalled();
		expect(scheduleSave).toHaveBeenCalledOnce();
	});

	test("ignores delayed Neovim echoes while the original editor is focused", () => {
		const nvim = { getText: () => "older draft", setText: vi.fn() };
		const editor = { getText: () => "current draft", setText: vi.fn() };
		const context: InputStateThis = {
			inputSessionDraft: "current draft",
			nvimInputMode: "i",
			restoringInputState: false,
			isBashMode: false,
			nvimViewportContainer: nvim,
			editor,
			updateEditorBorderColor: vi.fn(),
			scheduleInputSessionStateSave: vi.fn(),
			defaultEditor: {},
			ui: { requestRender: vi.fn() },
			renderer: { getFocusedComponent: () => editor },
		};

		prototype.handleNeovimDraftChange.call(context, "older draft", "i");

		expect(context.inputSessionDraft).toBe("current draft");
		expect(editor.setText).not.toHaveBeenCalled();
	});

	test("mirrors original-editor cursor changes into Neovim", async () => {
		const setCursorPosition = vi.fn(async () => {});
		const editor = { getText: () => "first\nsecond", setText: vi.fn() };
		const nvim = { getText: () => "first\nsecond", setText: vi.fn(), setCursorPosition };
		const context: CursorStateThis = {
			syncingInputCursor: false,
			nvimViewportContainer: nvim,
			editor,
			renderer: { getFocusedComponent: () => editor },
		};

		prototype.handleOriginalCursorChange.call(context, { line: 1, col: 3 });

		expect(setCursorPosition).toHaveBeenCalledWith({ line: 1, col: 3 });
	});

	test("mirrors focused Neovim cursor changes into the original editor", () => {
		const editor = { getText: () => "first\nsecond", setText: vi.fn(), setCursor: vi.fn() };
		const nvim = { getText: () => "first\nsecond", setText: vi.fn() };
		const context: CursorStateThis = {
			syncingInputCursor: false,
			nvimViewportContainer: nvim,
			editor,
			renderer: { getFocusedComponent: () => nvim },
		};

		prototype.handleNeovimCursorChange.call(context, { line: 1, col: 3 });

		expect(editor.setCursor).toHaveBeenCalledWith(1, 3);
		expect(context.syncingInputCursor).toBe(false);
	});

	test("syncs the cursor after clipboard text is inserted programmatically", () => {
		const cursor = { line: 4, col: 10 };
		const insertTextAtCursor = vi.fn();
		const handleOriginalCursorChange = vi.fn();
		const context: ClipboardStateThis = {
			editor: {
				getText: () => "",
				setText: vi.fn(),
				getCursor: () => cursor,
				insertTextAtCursor,
			},
			handleOriginalCursorChange,
		};

		prototype.insertClipboardTextAtCursor.call(context, "multiline clipboard text");

		expect(insertTextAtCursor).toHaveBeenCalledWith("multiline clipboard text");
		expect(handleOriginalCursorChange).toHaveBeenCalledWith(cursor);
	});

	test("does not let hidden Neovim cursor updates move the active original editor", () => {
		const editor = { getText: () => "draft", setText: vi.fn(), setCursor: vi.fn() };
		const nvim = { getText: () => "draft", setText: vi.fn() };
		const context: CursorStateThis = {
			syncingInputCursor: false,
			nvimViewportContainer: nvim,
			editor,
			renderer: { getFocusedComponent: () => editor },
		};

		prototype.handleNeovimCursorChange.call(context, { line: 0, col: 2 });

		expect(editor.setCursor).not.toHaveBeenCalled();
	});

	test.skipIf(!hasNeovim)(
		"keeps the same cursor after multiline paste, panel switches, and Neovim movement",
		async () => {
			const tui = new TuiMainScreen(new VirtualTerminal(40, 40));
			const editor = new Editor(tui, defaultEditorTheme);
			const text = "1234567890\n\n1234567890x\n\n1234567890";
			let context: InteractiveMode;
			const viewport = new NeovimViewport(
				tui,
				{
					onSubmit: () => {},
					onQuit: () => {},
					onDraftChange: (draft, mode) => prototype.handleNeovimDraftChange.call(context as any, draft, mode),
					onCursorChange: (cursor) => prototype.handleNeovimCursorChange.call(context as any, cursor),
					initialMode: "i",
				},
				["--embed", "-n", "-u", "NONE", "--cmd", `lua dofile(${JSON.stringify(piLuaPath)})`],
			);
			context = Object.assign(Object.create(InteractiveMode.prototype), {
				inputPanelMode: "orig",
				inputSessionDraft: "",
				nvimInputMode: "i",
				restoringInputState: false,
				syncingInputCursor: false,
				isBashMode: false,
				nvimViewportContainer: viewport,
				editor,
				renderer: tui,
				ui: tui,
				updateEditorBorderColor: () => {},
				scheduleInputSessionStateSave: () => {},
			}) as InteractiveMode;
			editor.onChange = (draft) => prototype.handleOriginalInputChange.call(context as any, draft);
			tui.setFocus(editor);
			try {
				await viewport.ready;
				editor.insertTextAtCursor(text);
				const expected = { line: 4, col: 10 };
				expect(editor.getCursor()).toEqual(expected);
				prototype.handleOriginalCursorChange.call(context as any, expected);
				viewport.setViewportSize(40, viewport.getNaturalHeight(40, 40));
				prototype.setInputPanelMode.call(context, "nvim");
				await vi.waitFor(() => expect(tui.getFocusedComponent()).toBe(viewport));
				await vi.waitFor(async () => expect(await viewport.getBufferLines()).toEqual(text.split("\n")));
				await vi.waitFor(async () => expect(await viewport.getCursorPosition()).toEqual(expected));
				await vi.waitFor(() => expect((viewport as any).cursor.row).toBe(4));

				viewport.handleInput("\x1b[D");
				await vi.waitFor(() => expect(editor.getCursor()).toEqual({ line: 4, col: 9 }));
				prototype.setInputPanelMode.call(context, "orig");
				await vi.waitFor(() => expect(tui.getFocusedComponent()).toBe(editor));
				expect(editor.getCursor()).toEqual({ line: 4, col: 9 });
			} finally {
				viewport.dispose();
			}
		},
	);

	test("Neovim submission uses Pi's normal submit handler and clears both editors", () => {
		const editor = { getText: () => "draft", setText: vi.fn() };
		const nvim = { getText: () => "draft", setText: vi.fn() };
		const onSubmit = vi.fn();
		const requestRender = vi.fn();
		const context: InputStateThis = {
			inputSessionDraft: "draft",
			nvimInputMode: "i",
			restoringInputState: false,
			isBashMode: false,
			nvimViewportContainer: nvim,
			editor,
			updateEditorBorderColor: vi.fn(),
			scheduleInputSessionStateSave: vi.fn(),
			defaultEditor: { onSubmit },
			ui: { requestRender },
		};

		prototype.submitFromNeovim.call(context, " /model ");

		expect(editor.setText).toHaveBeenCalledWith("");
		expect(nvim.setText).toHaveBeenCalledWith("");
		expect(onSubmit).toHaveBeenCalledWith("/model");
		expect(requestRender).toHaveBeenCalledOnce();
	});
});
