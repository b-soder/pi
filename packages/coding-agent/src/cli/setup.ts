import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";
import { parseArgs } from "./args.ts";

export function buildProcessTitle(appName: string, args: string[]): string {
	const { sessionId, name } = parseArgs(args);

	// Keep emitted values single-token; macOS title length is capped by the original argv byte length, which includes these flags.
	const safeValue = (value: string | undefined): string | undefined =>
		value !== undefined && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value) ? value : undefined;
	const safeSessionId = safeValue(sessionId);
	const safeName = safeValue(name);
	return `${appName}${safeSessionId ? ` --session-id ${safeSessionId}` : ""}${safeName ? ` --name ${safeName}` : ""}`;
}

export function setupCli(): void {
	process.title = buildProcessTitle(APP_NAME, process.argv.slice(2));
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
