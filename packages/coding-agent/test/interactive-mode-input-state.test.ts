import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type NvimMock = { getText: () => string; setText: (text: string) => void };
type EditorMock = { getText: () => string; setText: (text: string) => void };

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
};

const prototype = InteractiveMode.prototype as unknown as {
	handleOriginalInputChange(this: InputStateThis, text: string): void;
	handleNeovimDraftChange(this: InputStateThis, text: string, mode: "i" | "n"): void;
	submitFromNeovim(this: InputStateThis, text: string): void;
};

describe("InteractiveMode input state", () => {
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
		};

		prototype.handleNeovimDraftChange.call(context, "draft", "n");

		expect(context.inputSessionDraft).toBe("draft");
		expect(context.nvimInputMode).toBe("n");
		expect(nvim.setText).not.toHaveBeenCalled();
		expect(scheduleSave).toHaveBeenCalledOnce();
	});

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
