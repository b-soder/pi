import { setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";

afterEach(() => {
	setKeybindings(new KeybindingsManager());
});

describe("CustomEditor prompt history keybindings", () => {
	it("reports cursor changes after editor input, including cursor-only movement", () => {
		const keybindings = new KeybindingsManager();
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		const cursorChanges: Array<{ line: number; col: number }> = [];
		editor.onCursorChange = (cursor) => cursorChanges.push(cursor);
		editor.setText("abc");
		editor.setCursor(0, 1);

		editor.handleInput("X");
		expect(editor.getText()).toBe("aXbc");
		expect(cursorChanges.at(-1)).toEqual({ line: 0, col: 2 });

		editor.handleInput("\x1b[D");
		expect(cursorChanges.at(-1)).toEqual({ line: 0, col: 1 });

		editor.render(40);
		editor.handleMouse({
			type: "click",
			button: "left",
			clickCount: 1,
			x: 4,
			y: 1,
			screenX: 4,
			screenY: 1,
			width: 40,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
		});
		expect(cursorChanges.at(-1)).toEqual(editor.getCursor());
		expect(editor.getCursor()).toEqual({ line: 0, col: 4 });
	});

	it("gives an explicit history binding precedence over model cycling", () => {
		const keybindings = new KeybindingsManager({
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
		});
		setKeybindings(keybindings);
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		let modelCycles = 0;
		editor.onAction("app.model.cycleForward", () => {
			modelCycles++;
		});
		editor.addToHistory("previous prompt");
		editor.setText("draft");

		editor.handleInput("\x10"); // Ctrl+P
		expect(editor.getText()).toBe("previous prompt");
		expect(modelCycles).toBe(0);

		editor.handleInput("\x0e"); // Ctrl+N
		expect(editor.getText()).toBe("draft");
	});
});
