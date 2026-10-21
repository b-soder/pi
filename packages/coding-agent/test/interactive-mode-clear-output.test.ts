import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Activity = {
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning: boolean;
};

type ClearOutputContext = {
	session: Activity;
	chatContainer: { clear: () => void };
	toolOutputContainer: { clear: () => void };
	ui: { requestRender: () => void };
	showError: (message: string) => void;
};

const prototype = InteractiveMode.prototype as unknown as {
	handleClearOutputCommand(this: ClearOutputContext): void;
};

function makeContext(session: Activity): ClearOutputContext {
	return {
		session,
		chatContainer: { clear: vi.fn() },
		toolOutputContainer: { clear: vi.fn() },
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
	};
}

const idle: Activity = { isStreaming: false, isCompacting: false, isBashRunning: false };

describe("InteractiveMode /cl command", () => {
	it("is available as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMANDS).toContainEqual({
			name: "cl",
			description: "Clear visible output and tool output panels",
		});
	});

	it("clears both display panels without starting a new session", () => {
		const context = makeContext(idle);

		prototype.handleClearOutputCommand.call(context);

		expect(context.chatContainer.clear).toHaveBeenCalledOnce();
		expect(context.toolOutputContainer.clear).toHaveBeenCalledOnce();
		expect(context.ui.requestRender).toHaveBeenCalledOnce();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "streaming", session: { ...idle, isStreaming: true } },
		{ label: "compacting", session: { ...idle, isCompacting: true } },
		{ label: "running a bash command", session: { ...idle, isBashRunning: true } },
	])("does not clear panels while $label", ({ session }) => {
		const context = makeContext(session);

		prototype.handleClearOutputCommand.call(context);

		expect(context.chatContainer.clear).not.toHaveBeenCalled();
		expect(context.toolOutputContainer.clear).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledWith(
			"Wait for the current operation to finish before clearing output panels.",
		);
	});
});
