import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { CURSOR_MARKER, type TuiMouseEvent } from "../../tui/src/tui.ts";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { NeovimViewport as EmbeddedNeovimViewport } from "../src/modes/interactive/components/neovim-viewport.ts";

// Embedded tests kill their Neovim children; don't leave recoverable swap files
// that eventually make nvim_paste fail with E326 in subsequent runs.
class NeovimViewport extends EmbeddedNeovimViewport {
	constructor(...[tui, handlers, args]: ConstructorParameters<typeof EmbeddedNeovimViewport>) {
		super(tui, handlers, ["-n", ...(args ?? ["--embed"])]);
	}
}

const hasNeovim = spawnSync(process.env.NVIM ?? "nvim", ["--version"], { stdio: "ignore" }).status === 0;

describe("Neovim viewport", () => {
	test.skipIf(!hasNeovim)("attaches, renders, syncs drafts, resizes, and flushes through RPC", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		let submitted: string | undefined;
		let draftChanged: { text: string; mode: "i" | "n" } | undefined;
		let quit = false;
		let interrupted = false;
		const viewport = new NeovimViewport(
			tui,
			{
				onSubmit: (text) => {
					submitted = text;
				},
				onQuit: () => {
					quit = true;
				},
				onInterrupt: () => {
					interrupted = true;
				},
				onDraftChange: (text, mode) => {
					draftChanged = { text, mode };
				},
			},
			["--embed", "-u", "NONE"],
		);
		viewport.setViewportSize(40, 8);
		try {
			await viewport.ready;
			expect(await viewport.getMode()).toBe("n");
			viewport.focused = true;
			await viewport.replaceBuffer("viewport smoke test");
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(viewport.render(40).join("\n")).toContain("viewport smoke test");
			expect(viewport.render(40)[0]).toContain(CURSOR_MARKER);
			expect(tui.getCursorStyleSequence()).toBe("\x1b[2 q");
			viewport.handleInput("\x1b");
			await viWaitFor(async () => expect(await viewport.getMode()).toBe("n"));
			expect(interrupted).toBe(false);
			viewport.handleInput("i");
			await viWaitFor(async () => expect(await viewport.getMode()).toBe("i"));
			viewport.handleInput("\x1b");
			await viWaitFor(async () => expect(await viewport.getMode()).toBe("n"));
			expect(interrupted).toBe(false);
			viewport.setViewportSize(48, 14);
			await viewport.replaceBuffer("live nvim edit");
			viewport.handleInput(":PiFlush\r");
			viewport.handleInput("i");
			await viWaitFor(() => expect(submitted).toBe("live nvim edit"));
			await viWaitFor(() => expect(draftChanged).toEqual({ text: "", mode: "i" }));
			expect(await viewport.getBufferLines()).toEqual([""]);
			expect(await viewport.getMode()).toBe("i");
			viewport.handleInput("\x1b");
			viewport.handleInput(":PiQuit\r");
			viewport.handleInput("i");
			await viWaitFor(() => expect(quit).toBe(true));
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)(
		"forwards wheel events to Neovim while leaving selection gestures to the fullscreen TUI",
		async () => {
			const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
			const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {} }, ["--embed", "-u", "NONE"]);
			try {
				await viewport.ready;
				const request = vi.spyOn(viewport as any, "request");
				const base = {
					x: 2,
					y: 2,
					screenX: 2,
					screenY: 2,
					width: 40,
					height: 8,
					shift: false,
					alt: false,
					ctrl: false,
				};
				const events: TuiMouseEvent[] = [
					{ ...base, type: "press", button: "left" },
					{ ...base, type: "drag", button: "left" },
					{ ...base, type: "release", button: "left" },
					{ ...base, type: "click", button: "left", clickCount: 1 },
					{ ...base, type: "wheel", button: "none", wheelDelta: -1 },
					{ ...base, x: 4, y: 5, shift: true, alt: true, type: "wheel", button: "none", wheelDelta: 1 },
					{ ...base, type: "move", button: "none" },
				];

				for (const event of events) {
					const result = viewport.handleMouse(event);
					if (event.type === "wheel") expect(result?.handled).toBe(true);
					else expect(result).toBeUndefined();
				}
				await viWaitFor(() =>
					expect(
						request.mock.calls.filter(([method]) => method === "nvim_input_mouse").map(([, args]) => args),
					).toEqual([
						["wheel", "up", "", 1, 2, 2],
						["wheel", "down", "SA", 1, 5, 4],
					]),
				);
			} finally {
				viewport.dispose();
			}
		},
	);

	test.skipIf(!hasNeovim)("scrolls the embedded buffer on wheel input and clears the screen selection", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {} }, ["--embed", "-u", "NONE"]);
		viewport.setViewportSize(20, 4);
		tui.setLayoutRoot(viewport);
		tui.setFocus(viewport);
		try {
			await viewport.ready;
			await viewport.replaceBuffer(Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n"));
			await viewport.setCursorPosition({ line: 29, col: 0 });
			tui.start();
			await terminal.waitForRender();

			const getTopLine = async () => Number(await (viewport as any).request("nvim_eval", ["winsaveview().topline"]));
			const topBeforeScroll = await getTopLine();
			expect(topBeforeScroll).toBeGreaterThan(1);

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			expect(tui.hasActiveSelection()).toBe(true);

			terminal.sendInput("\x1b[<64;2;1M");
			await viWaitFor(async () => {
				expect((viewport as any).error).toBeUndefined();
				expect(await getTopLine()).toBeLessThan(topBeforeScroll);
			});
			expect(tui.hasActiveSelection()).toBe(false);
		} finally {
			tui.stop();
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("clears the fullscreen copy selection when Enter edits the Neovim buffer", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {}, initialMode: "i" }, [
			"--embed",
			"-u",
			"NONE",
		]);
		viewport.setViewportSize(20, 4);
		tui.setLayoutRoot(viewport);
		tui.setFocus(viewport);
		try {
			await viewport.ready;
			await viewport.replaceBuffer("alpha\nbeta");
			tui.start();
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;4;2M");
			terminal.sendInput("\x1b[<0;4;2m");
			await terminal.waitForRender();
			expect(tui.hasActiveSelection()).toBe(true);

			terminal.sendInput("\r");
			await viWaitFor(async () => expect((await viewport.getBufferLines()).length).toBe(3));
			expect(tui.hasActiveSelection()).toBe(false);
		} finally {
			tui.stop();
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("coalesces queued buffer and cursor mirror updates to the latest state", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {} }, ["--embed", "-u", "NONE"]);
		try {
			await viewport.ready;
			const requestTarget = viewport as unknown as {
				request: (method: string, args: unknown[]) => Promise<unknown>;
			};
			const request = vi.spyOn(requestTarget, "request");
			const bufferWrites: unknown[][] = [];
			const cursorWrites: unknown[][] = [];
			let releaseFirstWrite!: (value: unknown) => void;
			request.mockImplementation((method: string, args: unknown[]) => {
				if (method === "nvim_buf_set_lines") {
					bufferWrites.push(args);
					if (bufferWrites.length === 1) {
						return new Promise((resolve) => {
							releaseFirstWrite = resolve;
						});
					}
				}
				if (method === "nvim_win_set_cursor") cursorWrites.push(args);
				return Promise.resolve(undefined);
			});

			const firstWrite = viewport.replaceBuffer("first");
			await viWaitFor(() => expect(bufferWrites).toHaveLength(1));
			const secondWrite = viewport.replaceBuffer("stale");
			const latestWrite = viewport.replaceBuffer("latest");
			const firstCursor = viewport.setCursorPosition({ line: 0, col: 1 });
			const latestCursor = viewport.setCursorPosition({ line: 0, col: 3 });
			releaseFirstWrite(undefined);
			await Promise.all([firstWrite, secondWrite, latestWrite, firstCursor, latestCursor]);

			expect(bufferWrites.map((args) => args[4])).toEqual([["first"], ["latest"]]);
			expect(cursorWrites).toEqual([[0, [1, 3]]]);
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("pastes bracketed text intact in insert and append modes", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(80, 12));
		const url = "https://iterm2.com/documentation-csiu.html";
		const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {}, initialMode: "i" }, [
			"--embed",
			"-u",
			"NONE",
		]);
		try {
			await viewport.ready;
			viewport.handleInput(`\x1b[200~${url}`);
			viewport.handleInput("\x1b[201~");
			await viWaitFor(async () => expect(await viewport.getBufferLines()).toEqual([url]));

			const pastedBlock = "1234567890\n\n1234567890x\n\n1234567890";
			await viewport.replaceBuffer("");
			await viewport.setCursorPosition({ line: 0, col: 0 });
			viewport.handleInput(`\x1b[200~${pastedBlock}\x1b[201~`);
			await viWaitFor(async () => expect(await viewport.getBufferLines()).toEqual(pastedBlock.split("\n")));
			expect(await viewport.getCursorPosition()).toEqual({ line: 4, col: 10 });

			await viewport.replaceBuffer("1234567890");
			viewport.handleInput("\x1b");
			await viWaitFor(async () => expect(await viewport.getMode()).toBe("n"));
			viewport.handleInput("A");
			await viWaitFor(async () => expect(await viewport.getMode()).toBe("i"));
			viewport.handleInput(`\x1b[200~${url}\x1b[201~`);
			await viWaitFor(async () => expect(await viewport.getBufferLines()).toEqual([`1234567890${url}`]));
		} finally {
			viewport.dispose();
		}
	});

	for (const [label, separator] of [
		["LF", "\n"],
		["CR", "\r"],
		["CRLF", "\r\n"],
	] as const) {
		test.skipIf(!hasNeovim)(`pastes three ${label}-separated lines with the cursor on the last line`, async () => {
			const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
			const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {}, initialMode: "i" }, [
				"--embed",
				"-u",
				"NONE",
			]);
			viewport.setViewportSize(40, 3);
			try {
				await viewport.ready;
				viewport.focused = true;
				viewport.handleInput(`\x1b[200~123${separator}123${separator}123\x1b[201~`);
				await viWaitFor(async () => expect(await viewport.getBufferLines()).toEqual(["123", "123", "123"]));
				await viWaitFor(async () => expect(await viewport.getCursorPosition()).toEqual({ line: 2, col: 3 }));
			} finally {
				viewport.dispose();
			}
		});
	}

	test.skipIf(!hasNeovim)("reports real Neovim cursor movement through the bundled RPC bridge", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		let cursorChanged: { line: number; col: number } | undefined;
		const viewport = new NeovimViewport(
			tui,
			{
				onSubmit: () => {},
				onQuit: () => {},
				onCursorChange: (cursor) => {
					cursorChanged = cursor;
				},
				initialText: "first\nA😀B",
				initialMode: "i",
			},
			["--embed", "-u", "NONE"],
		);
		try {
			await viewport.ready;
			viewport.setViewportSize(40, 8);
			viewport.focused = true;
			await viewport.getMode();
			await viewport.setCursorPosition({ line: 1, col: 3 });
			viewport.handleInput("\x1b[D");
			await viWaitFor(() => expect(cursorChanged).toEqual({ line: 1, col: 1 }));
			await viWaitFor(() => expect((viewport as any).cursor.row).toBe(1));
			expect((viewport as any).stderr).not.toContain("invalid key: all");
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("keeps the linegrid cursor on the final row after multiline paste", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const pastedBlock = "1234567890\n\n1234567890x\n\n1234567890";
		const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {}, initialMode: "i" }, [
			"--embed",
			"-u",
			"NONE",
		]);
		viewport.setViewportSize(40, 8);
		try {
			await viewport.ready;
			viewport.focused = true;
			viewport.handleInput(`\x1b[200~${pastedBlock}\x1b[201~`);
			await viWaitFor(async () => expect(await viewport.getBufferLines()).toEqual(pastedBlock.split("\n")));
			expect(await viewport.getCursorPosition()).toEqual({ line: 4, col: 10 });
			await viWaitFor(() => expect((viewport as any).cursor.row).toBe(4));
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("reports the final cursor after multiline paste through the bundled bridge", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const pastedBlock = "1234567890\n\n1234567890x\n\n1234567890";
		let draftChanged: string | undefined;
		let cursorChanged: { line: number; col: number } | undefined;
		const viewport = new NeovimViewport(
			tui,
			{
				onSubmit: () => {},
				onQuit: () => {},
				onDraftChange: (text) => {
					draftChanged = text;
				},
				onCursorChange: (cursor) => {
					cursorChanged = cursor;
				},
				initialMode: "i",
			},
			["--embed", "-u", "NONE"],
		);
		try {
			await viewport.ready;
			viewport.focused = true;
			viewport.handleInput(`\x1b[200~${pastedBlock}\x1b[201~`);
			await viWaitFor(async () => expect(await viewport.getBufferLines()).toEqual(pastedBlock.split("\n")));
			await viWaitFor(() => expect(draftChanged).toBe(pastedBlock));
			await viWaitFor(() => expect(cursorChanged).toEqual({ line: 4, col: 10 }));
			expect(await viewport.getCursorPosition()).toEqual({ line: 4, col: 10 });
			await viWaitFor(() => expect((viewport as any).cursor).toMatchObject({ grid: 1, row: 0, col: 10 }));
			const cursorRows = viewport
				.render(40)
				.map((line, index) => (line.includes(CURSOR_MARKER) ? index : -1))
				.filter((index) => index >= 0);
			expect(cursorRows).toEqual([0]);
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("renders Neovim's command line and cursor in the divider row", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const viewport = new NeovimViewport(
			tui,
			{ onSubmit: () => {}, onQuit: () => {}, initialText: "test", initialMode: "n" },
			["--embed", "-u", "NONE"],
		);
		viewport.setViewportSize(40, 1);
		try {
			await viewport.ready;
			viewport.focused = true;
			viewport.handleInput(":s/test/ok/g");
			await viWaitFor(() =>
				expect(stripVTControlCharacters(viewport.renderCommandRow(40) ?? "")).toContain(":s/test/ok/g"),
			);
			expect(viewport.renderCommandRow(40)).toContain(CURSOR_MARKER);
			expect(stripVTControlCharacters(viewport.render(40).join("\n"))).not.toContain(":s/test/ok/g");
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("distinguishes Neovim soft wraps from real buffer newlines", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(20, 10));
		const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {} }, ["--embed", "-u", "NONE"]);
		viewport.setViewportSize(20, 4);
		try {
			await viewport.ready;
			await viewport.replaceBuffer("abcdefghijklmnopqrstuvxyz");
			await viWaitFor(() => expect(viewport.getSelectionJoinerAfterRow(0, 20)).toBe(""));
			expect(viewport.getSelectionJoinerAfterRow(1, 20)).toBeUndefined();
			await viewport.replaceBuffer("first\nsecond");
			await viWaitFor(() => expect(viewport.getSelectionJoinerAfterRow(0, 20)).toBeUndefined());
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)(
		"copies a wrapped Neovim buffer line without a newline but keeps real newlines",
		async () => {
			const terminal = new VirtualTerminal(20, 8);
			const copied: string[] = [];
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copyOnSelect: false,
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {} }, ["--embed", "-u", "NONE"]);
			vi.spyOn(tui, "flash").mockImplementation(() => {});
			viewport.setViewportSize(20, 4);
			tui.setLayoutRoot(viewport);
			try {
				await viewport.ready;
				await viewport.replaceBuffer("abcdefghijklmnopqrstuvwx\nsecond");
				tui.start();
				await terminal.waitForRender();
				await viWaitFor(() => expect(viewport.getSelectionJoinerAfterRow(0, 20)).toBe(""));
				terminal.sendInput("\x1b[<0;1;1M");
				terminal.sendInput("\x1b[<32;4;2M");
				terminal.sendInput("\x1b[<0;4;2m");
				await terminal.waitForRender();
				expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
				expect(copied).toEqual(["abcdefghijklmnopqrstuvwx"]);
				terminal.sendInput("\x1b[<0;1;1M");
				terminal.sendInput("\x1b[<32;6;3M");
				terminal.sendInput("\x1b[<0;6;3m");
				await terminal.waitForRender();
				expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
				expect(copied).toEqual(["abcdefghijklmnopqrstuvwx", "abcdefghijklmnopqrstuvwx\nsecond"]);
				tui.resetTextSelection();
				for (let click = 0; click < 3; click++) {
					terminal.sendInput("\x1b[<0;2;1M");
					terminal.sendInput("\x1b[<0;2;1m");
				}
				await terminal.waitForRender();
				expect(await tui.copyActiveSelectionToClipboard()).toBe(true);
				expect(copied.at(-1)).toBe("abcdefghijklmnopqrstuvwx");
			} finally {
				tui.stop();
				viewport.dispose();
			}
		},
	);

	test.skipIf(!hasNeovim)("moves the cursor to the divider on the first colon of a command", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const viewport = new NeovimViewport(
			tui,
			{ onSubmit: () => {}, onQuit: () => {}, initialText: "123\n123\n123", initialMode: "n" },
			["--embed", "-u", "NONE"],
		);
		viewport.setViewportSize(40, 3);
		try {
			await viewport.ready;
			viewport.focused = true;
			await viewport.setCursorPosition({ line: 1, col: 0 });
			const frames: Array<{ bufferCursor: boolean; commandCursor: boolean }> = [];
			const originalRender = tui.requestRender.bind(tui);
			const renderSpy = vi.spyOn(tui, "requestRender").mockImplementation(() => {
				const command = viewport.renderCommandRow(40) ?? "";
				if (stripVTControlCharacters(command).includes(":")) {
					frames.push({
						bufferCursor: viewport.render(40).join("\n").includes(CURSOR_MARKER),
						commandCursor: command.includes(CURSOR_MARKER),
					});
				}
				originalRender();
			});
			viewport.handleInput(":");
			await viWaitFor(() => expect(stripVTControlCharacters(viewport.renderCommandRow(40) ?? "")).toContain(":"));
			expect(viewport.renderCommandRow(40)).toContain(CURSOR_MARKER);
			expect(viewport.render(40).join("\n")).not.toContain(CURSOR_MARKER);
			expect(frames.length).toBeGreaterThan(0);
			expect(frames.every((frame) => frame.commandCursor && !frame.bufferCursor)).toBe(true);
			renderSpy.mockRestore();
			viewport.handleInput("a");
			await viWaitFor(() => expect(stripVTControlCharacters(viewport.renderCommandRow(40) ?? "")).toContain(":a"));
			expect(viewport.renderCommandRow(40)).toContain(CURSOR_MARKER);
			viewport.handleInput("\x1b");
			await viWaitFor(() => expect(viewport.render(40).join("\n")).toContain(CURSOR_MARKER));
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("sizes the buffer like the original editor, reserving its divider command row", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 24));
		const viewport = new NeovimViewport(tui, { onSubmit: () => {}, onQuit: () => {} }, ["--embed", "-u", "NONE"]);
		try {
			await viewport.ready;
			expect(viewport.getNaturalHeight(40, 24)).toBe(1);
			await viewport.replaceBuffer("first\nsecond\nthird");
			expect(viewport.getNaturalHeight(40, 24)).toBe(3);
			await viewport.replaceBuffer(Array.from({ length: 20 }, () => "line").join("\n"));
			expect(viewport.getNaturalHeight(40, 24)).toBe(6);
			expect(viewport.getNaturalHeight(40, 40)).toBe(11);
			await viewport.replaceBuffer("short");
			expect(viewport.getNaturalHeight(40, 24)).toBe(1);
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("restores the visible cursor after focusing a resumed Neovim panel", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const viewport = new NeovimViewport(
			tui,
			{ onSubmit: () => {}, onQuit: () => {}, initialText: "resumed draft", initialMode: "n" },
			["--embed", "-u", "NONE"],
		);
		try {
			await viewport.ready;
			await viewport.restoreState("resumed draft", "n");
			viewport.focused = true;
			expect(viewport.render(40).join("\n")).toContain(CURSOR_MARKER);
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("clamps the Normal-mode cursor to the last character and deletes it normally", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const viewport = new NeovimViewport(
			tui,
			{ onSubmit: () => {}, onQuit: () => {}, initialText: "abc", initialMode: "n" },
			["--embed", "-u", "NONE"],
		);
		try {
			await viewport.ready;
			await viewport.setCursorPosition({ line: 0, col: 3 });
			expect(await viewport.getMode()).toBe("n");
			expect(await viewport.getCursorPosition()).toEqual({ line: 0, col: 2 });

			viewport.handleInput("x");
			await viWaitFor(async () => expect(await viewport.getBufferLines()).toEqual(["ab"]));
			expect(await viewport.getCursorPosition()).toEqual({ line: 0, col: 1 });
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("synchronizes logical cursor positions, including UTF-8 byte columns", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		let cursorChanged: { line: number; col: number } | undefined;
		const viewport = new NeovimViewport(
			tui,
			{
				onSubmit: () => {},
				onQuit: () => {},
				onCursorChange: (cursor) => {
					cursorChanged = cursor;
				},
				initialText: "first\nA😀B",
				initialMode: "i",
			},
			["--embed", "-u", "NONE"],
		);
		try {
			await viewport.ready;
			await viewport.setCursorPosition({ line: 1, col: 3 });
			expect(await viewport.getCursorPosition()).toEqual({ line: 1, col: 3 });
			viewport.focused = true;
			(viewport as any).handleDraft([["first", "A😀B"], "i", [2, 5], [2, 4]]);
			expect(cursorChanged).toEqual({ line: 1, col: 3 });
		} finally {
			viewport.dispose();
		}
	});

	test.skipIf(!hasNeovim)("restores an existing multiline draft and normal Neovim mode", async () => {
		const tui = new TuiMainScreen(new VirtualTerminal(40, 12));
		const viewport = new NeovimViewport(
			tui,
			{
				onSubmit: () => {},
				onQuit: () => {},
				initialText: "restored draft\nsecond line",
				initialMode: "n",
			},
			["--embed", "-u", "NONE"],
		);
		try {
			await viewport.ready;
			expect(await viewport.getBufferLines()).toEqual(["restored draft", "second line"]);
			expect(await viewport.getMode()).toBe("n");
			await viewport.restoreState("updated draft", "i");
			expect(await viewport.getBufferLines()).toEqual(["updated draft"]);
			expect(await viewport.getMode()).toBe("i");
		} finally {
			viewport.dispose();
		}
	});
});

async function viWaitFor(assertion: () => void | Promise<void>): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		try {
			await assertion();
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	await assertion();
}
