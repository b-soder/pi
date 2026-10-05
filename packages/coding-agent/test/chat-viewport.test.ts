import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { Editor } from "../../tui/src/components/editor.ts";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("places activity and status outside the input panel", () => {
		const activity = new Container();
		activity.addChild(new Text("OM worker", 0, 0));
		const status = new Container();
		status.addChild(new Text(": Working", 0, 0));
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput: new Container(),
			nvimViewport: new Text("Neovim viewport - not connected", 1, 0),
			fourPanel: true,
			activity: new VStack([activity, status]),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const frame = renderLayoutFrame(viewport.root, 80, 40, () => {});
		const rendered = frame.lines.join("\\n");

		expect(rendered).toContain("OM worker");
		expect(rendered).toContain(": Working");
		expect(rendered.indexOf(": Working")).toBe(rendered.lastIndexOf(": Working"));
		expect(frame.root.children).toHaveLength(9);
		expect(frame.root.children[4]!.rect.height).toBeGreaterThanOrEqual(3);
	});

	test("places extension activity in the transcript instead of input", () => {
		const activity = new Container();
		activity.addChild(new Text("OM observer running", 0, 0));
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput: new Container(),
			fourPanel: true,
			activity,
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			getTerminalRows: () => 40,
			getTerminalColumns: () => 80,
		});
		const frame = renderLayoutFrame(viewport.root, 80, 40, () => {});

		expect(frame.lines.join("\n")).toContain("OM observer running");
		expect(viewport.transcript.children[0]).toHaveProperty("children");
	});

	test("builds five panels with the Neovim viewport between transcript and input", () => {
		const toolOutput = new Container();
		const nvimViewport = new Container();
		nvimViewport.addChild(new Text("Neovim viewport - not connected", 1, 0));
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput,
			nvimViewport,
			fourPanel: true,
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			getTerminalRows: () => 40,
			getTerminalColumns: () => 80,
		});
		const frame = renderLayoutFrame(viewport.root, 80, 40, () => {});

		expect(viewport.toolOutput).toBeInstanceOf(ScrollView);
		expect(viewport.toolOutput?.overscroll).toBe("contain");
		expect(viewport.transcript.primary).toBe(true);
		expect(frame.root.children).toHaveLength(9);
		expect(frame.root.children[4]!.rect.y).toBeGreaterThan(frame.root.children[2]!.rect.y);
		expect(frame.root.children[6]!.rect.y).toBeGreaterThan(frame.root.children[4]!.rect.y);
		expect(frame.lines.join("\\n")).toContain("Neovim viewport - not connected");
	});

	test("shows only selected input panels and keeps the hidden panel's Neovim instance mounted", () => {
		const inputMode = { value: "orig" as "orig" | "nvim" | "both" };
		const nvim = new Text("NEOVIM PANEL", 0, 0);
		const originalInput = new Text("ORIGINAL INPUT", 0, 0);
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput: new Container(),
			nvimViewport: nvim,
			fourPanel: true,
			getInputMode: () => inputMode.value,
			pendingMessages: new Container(),
			status: new Container(),
			editor: originalInput,
			footer: new Container(),
			getTerminalRows: () => 40,
			getTerminalColumns: () => 80,
		});

		const render = () => renderLayoutFrame(viewport.root, 80, 40, () => {});
		let frame = render();
		expect(frame.root.children).toHaveLength(7);
		expect(frame.lines.join("\\n")).toContain("ORIGINAL INPUT");
		expect(frame.lines.join("\\n")).not.toContain("NEOVIM PANEL");

		inputMode.value = "nvim";
		frame = render();
		expect(frame.root.children).toHaveLength(7);
		expect(frame.lines.join("\\n")).toContain("NEOVIM PANEL");
		expect(frame.lines.join("\\n")).not.toContain("ORIGINAL INPUT");
		expect((viewport.root as Container).children).toContain(nvim);

		inputMode.value = "both";
		frame = render();
		expect(frame.root.children).toHaveLength(9);
		expect(frame.lines.join("\\n")).toContain("NEOVIM PANEL");
		expect(frame.lines.join("\\n")).toContain("ORIGINAL INPUT");
		expect(frame.root.children.reduce((height, child) => height + child.rect.height, 0)).toBe(40);

		const footerHeight = frame.root.children.at(-1)!.rect.height;
		for (let iteration = 0; iteration < 12; iteration++) {
			inputMode.value = "nvim";
			frame = render();
			expect(frame.root.children.reduce((height, child) => height + child.rect.height, 0)).toBe(40);
			inputMode.value = "both";
			frame = render();
			expect(frame.root.children.reduce((height, child) => height + child.rect.height, 0)).toBe(40);
			expect(frame.root.children.at(-1)!.rect.height).toBe(footerHeight);
		}
	});

	test("can stop the fullscreen renderer without overflowing panel sizing", async () => {
		const terminal = new VirtualTerminal(80, 40);
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput: new Container(),
			nvimViewport: new Text("Neovim panel", 0, 0),
			fourPanel: true,
			getInputMode: () => "orig",
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Text("prompt", 0, 0),
			footer: new Container(),
			getTerminalRows: () => terminal.rows,
			getTerminalColumns: () => terminal.columns,
		});
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(viewport.root);
		tui.setViewportBorderStyle((text) => text);
		tui.start();
		await terminal.waitForRender();

		expect(() => tui.stop()).not.toThrow();
	});

	test("resizes adjacent panels by dragging their separator", () => {
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput: new Container(),
			fourPanel: true,
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			getTerminalRows: () => 40,
			getTerminalColumns: () => 80,
		});
		const frame = renderLayoutFrame(viewport.root, 80, 40, () => {});
		const dividerBox = frame.root.children.find(
			(box) => box.rect.height === 1 && box.component.handleMouse !== undefined,
		);
		expect(dividerBox).toBeDefined();
		if (!dividerBox) return;
		const before = frame.root.children[0]!.rect.height;
		const send = (type: "press" | "drag", screenY: number) =>
			dividerBox.component.handleMouse?.({
				type,
				button: "left",
				x: 0,
				y: screenY - dividerBox.rect.y,
				screenX: 0,
				screenY,
				width: 80,
				height: 1,
				shift: false,
				alt: false,
				ctrl: false,
			});
		const dividerY = dividerBox.rect.y;
		const press = send("press", dividerY);
		expect(press?.capture).toBe(true);
		send("drag", dividerY + 3);
		const resized = renderLayoutFrame(viewport.root, 80, 40, () => {});
		expect(resized.root.children[0]!.rect.height).toBe(before + 3);
	});

	test("grows the input panel when the first newline is inserted into a real editor", () => {
		const terminalRows = { value: 24 };
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, terminalRows.value)), defaultEditorTheme);
		editor.setPanelBordersHidden(true);
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput: new Container(),
			nvimViewport: new Text("Neovim viewport - not connected", 1, 0),
			fourPanel: true,
			pendingMessages: new Container(),
			activity: new Container(),
			status: new Container(),
			editor,
			footer: new Container(),
			getTerminalRows: () => terminalRows.value,
			getTerminalColumns: () => 80,
		});
		const measureInput = () =>
			renderLayoutFrame(viewport.root, 80, terminalRows.value, () => {}).root.children[6]!.rect.height;

		const emptyHeight = measureInput();
		expect(emptyHeight).toBe(1);
		terminalRows.value = 40;
		expect(measureInput()).toBe(1);
		terminalRows.value = 24;
		expect(measureInput()).toBe(1);
		editor.handleInput("111");
		expect(measureInput()).toBe(emptyHeight);
		editor.handleInput("\x1b[13;2u");
		const newlineFrame = renderLayoutFrame(viewport.root, 80, terminalRows.value, () => {});
		expect(newlineFrame.root.children[6]!.rect.height).toBe(emptyHeight + 1);
		expect(newlineFrame.lines.join("\n")).toContain("111");
		expect(editor.render(80)).toHaveLength(2);
		expect(newlineFrame.root.children[6]!.children[1]!.rect.height).toBe(2);
		terminalRows.value = 40;
		const expandedFrame = renderLayoutFrame(viewport.root, 80, terminalRows.value, () => {});
		expect(expandedFrame.root.children[6]!.rect.height).toBe(2);
		expect(expandedFrame.lines.join("\n")).toContain("111");
		terminalRows.value = 24;
		const shrunkFrame = renderLayoutFrame(viewport.root, 80, terminalRows.value, () => {});
		expect(shrunkFrame.root.children[6]!.rect.height).toBe(2);
		expect(shrunkFrame.lines.join("\n")).toContain("111");
		editor.handleInput("\x1b[13;2u");
		const secondNewlineFrame = renderLayoutFrame(viewport.root, 80, terminalRows.value, () => {});
		expect(secondNewlineFrame.root.children[6]!.rect.height).toBe(3);
		expect(secondNewlineFrame.lines.join("\n")).toContain("111");

		editor.setText("");
		renderLayoutFrame(viewport.root, 80, terminalRows.value, () => {});
		const reopenedInput = renderLayoutFrame(viewport.root, 80, terminalRows.value, () => {}).root.children[6]!;
		expect(reopenedInput.rect.height).toBe(1);
	});

	test("reserves the footer height from its rendered content and omits panel labels", () => {
		const status = new Container();
		status.addChild(new Text("status line\nthird status line", 0, 0));
		const viewport = createChatViewport({
			document: new Container(),
			toolOutput: new Container(),
			fourPanel: true,
			pendingMessages: new Container(),
			status,
			editor: new Container(),
			footer: new Container(),
			getTerminalRows: () => 40,
			getTerminalColumns: () => 80,
		});
		const frame = renderLayoutFrame(viewport.root, 80, 40, () => {});
		const footer = frame.root.children.at(-1);
		expect(footer?.rect.height).toBe(0);
		expect(frame.lines.join("\\n")).not.toContain("TOOLS");
		expect(frame.lines.join("\\n")).not.toContain("PI");
		expect(frame.lines.join("\\n")).not.toContain("INPUT");
	});
});
