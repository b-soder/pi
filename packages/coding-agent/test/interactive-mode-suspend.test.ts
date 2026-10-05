import { afterEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type FakeUi = {
	start: () => void;
	stop: () => void;
	requestRender: (force?: boolean) => void;
};

type HandleCtrlZThis = {
	ui: FakeUi;
};

type ProcessSignalHandler = () => void;

type PanelInputUi = {
	hasOverlay: () => boolean;
	getFocusedComponent: () => object | null;
};

type HandlePanelInputThis = {
	keybindings: KeybindingsManager;
	nvimViewportContainer: object;
	handleCtrlZ: () => void;
	handlePiInterrupt?: () => void;
	toggleInputPanel: () => void;
	cycleModel?: (direction: "forward" | "backward") => void;
};

type InteractiveModePrototypeWithHandleCtrlZ = {
	handleCtrlZ(this: HandleCtrlZThis): void;
};

function callHandleCtrlZ(context: HandleCtrlZThis): void {
	(interactiveModePrototype as InteractiveModePrototypeWithHandleCtrlZ).handleCtrlZ.call(context);
}

const interactiveModePrototype = InteractiveMode.prototype as unknown;

function callHandlePanelInput(
	context: HandlePanelInputThis,
	data: string,
	ui: PanelInputUi,
): { consume?: true; data?: string } | undefined {
	const prototype = interactiveModePrototype as {
		handlePanelInput(
			this: HandlePanelInputThis,
			data: string,
			tui: PanelInputUi,
		): { consume?: true; data?: string } | undefined;
	};
	return prototype.handlePanelInput.call(context, data, ui);
}

describe("InteractiveMode.handleCtrlZ", () => {
	test("leaves Command-Ctrl-P for embedded Neovim instead of treating it as a Pi action", () => {
		const nvim = {};
		const cycleModel = vi.fn();
		const context: HandlePanelInputThis = {
			keybindings: new KeybindingsManager(),
			nvimViewportContainer: nvim,
			handleCtrlZ: vi.fn(),
			handlePiInterrupt: vi.fn(),
			toggleInputPanel: vi.fn(),
			cycleModel,
		};
		const ui: PanelInputUi = { hasOverlay: () => false, getFocusedComponent: () => nvim };

		expect(callHandlePanelInput(context, "\x1b[112;13u", ui)).toBeUndefined();
		expect(cycleModel).not.toHaveBeenCalled();
	});

	test("turns Command-Escape into overlay Escape without interrupting Pi", () => {
		const nvim = {};
		const handlePiInterrupt = vi.fn();
		const context: HandlePanelInputThis = {
			keybindings: new KeybindingsManager(),
			nvimViewportContainer: nvim,
			handleCtrlZ: vi.fn(),
			handlePiInterrupt,
			toggleInputPanel: vi.fn(),
		};
		const ui: PanelInputUi = { hasOverlay: () => true, getFocusedComponent: () => nvim };

		expect(context.keybindings.getKeys("app.input.interrupt")).toEqual(["super+escape"]);
		expect(context.keybindings.matches("\x1b[27;9u", "app.input.interrupt")).toBe(true);
		expect(callHandlePanelInput(context, "\x1b[27;9u", ui)).toEqual({ data: "\x1b" });
		expect(handlePiInterrupt).not.toHaveBeenCalled();
	});

	test("consumes Command-/ without switching panels while an overlay is open", () => {
		const nvim = {};
		const toggleInputPanel = vi.fn();
		const context: HandlePanelInputThis = {
			keybindings: new KeybindingsManager(),
			nvimViewportContainer: nvim,
			handleCtrlZ: vi.fn(),
			handlePiInterrupt: vi.fn(),
			toggleInputPanel,
		};
		const ui: PanelInputUi = { hasOverlay: () => true, getFocusedComponent: () => nvim };

		expect(context.keybindings.matches("\x1b[47;9u", "app.input.toggle")).toBe(true);
		expect(callHandlePanelInput(context, "\x1b[47;9u", ui)).toEqual({ consume: true });
		expect(toggleInputPanel).not.toHaveBeenCalled();
		expect(context.handlePiInterrupt).not.toHaveBeenCalled();
	});

	test("routes Ctrl-Z from the focused embedded Neovim panel to Pi suspend", () => {
		const nvim = {};
		const handleCtrlZ = vi.fn();
		const toggleInputPanel = vi.fn();
		const context: HandlePanelInputThis = {
			keybindings: new KeybindingsManager(),
			nvimViewportContainer: nvim,
			handleCtrlZ,
			toggleInputPanel,
		};
		const ui: PanelInputUi = {
			hasOverlay: () => false,
			getFocusedComponent: () => nvim,
		};

		expect(callHandlePanelInput(context, "\x1a", ui)).toEqual({ consume: true });
		expect(handleCtrlZ).toHaveBeenCalledOnce();
		expect(toggleInputPanel).not.toHaveBeenCalled();
	});

	test("leaves Ctrl-Z for an open overlay instead of suspending Pi", () => {
		const nvim = {};
		const handleCtrlZ = vi.fn();
		const context: HandlePanelInputThis = {
			keybindings: new KeybindingsManager(),
			nvimViewportContainer: nvim,
			handleCtrlZ,
			toggleInputPanel: vi.fn(),
		};
		const ui: PanelInputUi = {
			hasOverlay: () => true,
			getFocusedComponent: () => nvim,
		};

		expect(callHandlePanelInput(context, "\x1a", ui)).toBeUndefined();
		expect(handleCtrlZ).not.toHaveBeenCalled();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("shows a status message and skips suspend on Windows", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const showStatus = vi.fn();
		const context: HandleCtrlZThis & { showStatus: (message: string) => void } = { ui, showStatus };
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			configurable: true,
			value: "win32",
		});
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const processOnSpy = vi.spyOn(process, "on");
		const processOnceSpy = vi.spyOn(process, "once");
		const processKillSpy = vi.spyOn(process, "kill");

		try {
			callHandleCtrlZ(context);
		} finally {
			if (platformDescriptor) {
				Object.defineProperty(process, "platform", platformDescriptor);
			}
		}

		expect(showStatus).toHaveBeenCalledWith("Suspend to background is not supported on Windows");
		expect(ui.stop).not.toHaveBeenCalled();
		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(processOnSpy).not.toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).not.toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(processKillSpy).not.toHaveBeenCalled();
	});

	test("keeps the process alive while suspended and restores the TUI on SIGCONT", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);

		let sigintHandler: ProcessSignalHandler | undefined;
		let sigcontHandler: ProcessSignalHandler | undefined;

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGINT") {
				sigintHandler = listener;
			}
			return process;
		}) as typeof process.on);
		const processOnceSpy = vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
			if (event === "SIGCONT") {
				sigcontHandler = listener;
			}
			return process;
		}) as typeof process.once);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		callHandleCtrlZ(context);

		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2 ** 30);
		expect(processOnSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(processOnceSpy).toHaveBeenCalledWith("SIGCONT", expect.any(Function));
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(processKillSpy).toHaveBeenCalledWith(0, "SIGTSTP");
		expect(sigintHandler).toBeDefined();
		expect(sigcontHandler).toBeDefined();

		sigcontHandler?.();

		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", sigintHandler);
		expect(ui.start).toHaveBeenCalledTimes(1);
		expect(ui.requestRender).toHaveBeenCalledWith(true);
	});

	test("cleans up the temporary handlers if suspension fails", () => {
		const ui: FakeUi = {
			start: vi.fn(),
			stop: vi.fn(),
			requestRender: vi.fn(),
		};
		const context: HandleCtrlZThis = { ui };
		const keepAliveHandle = setTimeout(() => undefined, 0);
		clearTimeout(keepAliveHandle);
		const suspendError = new Error("suspend failed");

		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(keepAliveHandle);
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
		vi.spyOn(process, "on").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.on,
		);
		const removeListenerSpy = vi
			.spyOn(process, "removeListener")
			.mockImplementation(((_event: string, _listener: () => void) => process) as typeof process.removeListener);
		vi.spyOn(process, "once").mockImplementation(
			((_event: string, _listener: () => void) => process) as typeof process.once,
		);
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw suspendError;
		});

		expect(() => callHandleCtrlZ(context)).toThrow(suspendError);
		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
		expect(removeListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(ui.start).not.toHaveBeenCalled();
		expect(ui.requestRender).not.toHaveBeenCalled();
	});
});
