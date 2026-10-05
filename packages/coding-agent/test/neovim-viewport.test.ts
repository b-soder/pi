import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { CURSOR_MARKER } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { NeovimViewport } from "../src/modes/interactive/components/neovim-viewport.ts";

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
			[
				"--embed",
				"-u",
				"NONE",
				"--cmd",
				"lua vim.keymap.set('n', '<Esc>', function() local channel = vim.g.pi_channel; if type(channel) == 'number' then vim.rpcnotify(channel, 'pi_interrupt') end; return '<Esc>' end, { expr = true, noremap = true, silent = true })",
				"--cmd",
				"command! PiFlushTest lua local lines = {'live nvim edit'}; vim.api.nvim_buf_set_lines(0, 0, -1, true, lines); vim.rpcnotify(vim.g.pi_channel, 'pi_draft', lines, 'n'); vim.rpcnotify(vim.g.pi_channel, 'pi_submit', lines); vim.api.nvim_buf_set_lines(0, 0, -1, true, {''})",
				"--cmd",
				"command! PiQuitTest lua vim.rpcnotify(vim.g.pi_channel, 'pi_quit')",
			],
		);
		viewport.setViewportSize(40, 8);
		try {
			await viewport.ready;
			expect(await viewport.getMode()).toBe("i");
			viewport.focused = true;
			await viewport.replaceBuffer("viewport smoke test");
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(viewport.render(40).join("\n")).toContain("viewport smoke test");
			expect(viewport.render(40)[0]).toContain(CURSOR_MARKER);
			expect(tui.getCursorStyleSequence()).toBe("\x1b[6 q");
			viewport.handleInput("\x1b");
			await viWaitFor(async () => expect(await viewport.getMode()).toBe("n"));
			expect(interrupted).toBe(false);
			viewport.setViewportSize(48, 14);
			viewport.handleInput("\x1b");
			await viWaitFor(() => expect(interrupted).toBe(true));
			expect(await viewport.getMode()).toBe("n");
			viewport.handleInput(":PiFlushTest\r");
			viewport.handleInput("i");
			await viWaitFor(() => expect(submitted).toBe("live nvim edit"));
			await viWaitFor(() => expect(draftChanged).toEqual({ text: "live nvim edit", mode: "n" }));
			expect(await viewport.getBufferLines()).toEqual([""]);
			expect(await viewport.getMode()).toBe("i");
			viewport.handleInput("\x1b");
			viewport.handleInput(":PiQuitTest\r");
			viewport.handleInput("i");
			await viWaitFor(() => expect(quit).toBe(true));
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
	const deadline = Date.now() + 1000;
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
