/**
 * TUI session selector for --resume flag
 */

import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

type SessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

// The bundled OM workers pass these reserved names with `pi -n`.
const OM_WORKER_SESSION_NAME = /^om-(?:observer|consolidator)-/;

export function isObservationalMemoryWorkerSession(session: SessionInfo): boolean {
	return OM_WORKER_SESSION_NAME.test(session.name ?? "");
}

export function hideObservationalMemoryWorkerSessions(loader: SessionsLoader): SessionsLoader {
	return async (onProgress, signal) => {
		const filteredProgress: SessionListProgress | undefined = onProgress
			? (loaded, total, partialSessions) =>
					onProgress(
						loaded,
						total,
						partialSessions?.filter((session) => !isObservationalMemoryWorkerSession(session)),
					)
			: undefined;
		return (await loader(filteredProgress, signal)).filter((session) => !isObservationalMemoryWorkerSession(session));
	};
}

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings, initialNameFilter: "named" },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}
