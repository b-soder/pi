import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type InputPanelMode = "orig" | "nvim" | "both";
export type NeovimInputMode = "i" | "n";

export interface InputSessionState {
	sessionId: string;
	draft: string;
	inputPanelMode: InputPanelMode;
	nvimMode: NeovimInputMode;
}

export function getInputSessionStatePath(sessionFile: string): string {
	return `${sessionFile}.ui-state.json`;
}

export function readInputSessionState(filePath: string, sessionId: string): InputSessionState | undefined {
	if (!existsSync(filePath)) return undefined;
	try {
		const data: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!isRecord(data) || data.version !== 1 || data.sessionId !== sessionId || typeof data.draft !== "string") {
			return undefined;
		}
		if (
			(data.inputPanelMode !== "orig" && data.inputPanelMode !== "nvim" && data.inputPanelMode !== "both") ||
			(data.nvimMode !== "i" && data.nvimMode !== "n")
		) {
			return undefined;
		}
		return {
			sessionId,
			draft: data.draft,
			inputPanelMode: data.inputPanelMode,
			nvimMode: data.nvimMode,
		};
	} catch {
		return undefined;
	}
}

export function writeInputSessionState(filePath: string, state: InputSessionState): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const contents = `${JSON.stringify({ version: 1, ...state })}\n`;
	try {
		writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
		renameSync(temporaryPath, filePath);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Best-effort cleanup after a failed atomic state write.
		}
		throw error;
	}
}

export function deleteInputSessionState(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
