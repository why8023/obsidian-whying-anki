import type { ObakSettings } from "./settings";

const LOG_PREFIX = "[obsidian-obak]";

type VerboseLogSource =
	| boolean
	| Pick<ObakSettings, "enableVerboseLogging">
	| { settings: Pick<ObakSettings, "enableVerboseLogging"> };

export function logVerbose(
	source: VerboseLogSource,
	message: string,
	details?: unknown,
): void {
	if (!isVerboseLoggingEnabled(source)) {
		return;
	}

	if (details === undefined) {
		console.info(LOG_PREFIX, message);
		return;
	}

	console.info(LOG_PREFIX, message, details);
}

export function logError(message: string, details?: unknown): void {
	if (details === undefined) {
		console.error(LOG_PREFIX, message);
		return;
	}

	console.error(LOG_PREFIX, message, details);
}

function isVerboseLoggingEnabled(source: VerboseLogSource): boolean {
	if (typeof source === "boolean") {
		return source;
	}

	if ("settings" in source) {
		return source.settings.enableVerboseLogging;
	}

	return source.enableVerboseLogging;
}
