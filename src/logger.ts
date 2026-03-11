import type { ObakSettings } from "./settings";

const LOG_PREFIX = "[obsidian-obak]";

// 允许直接传布尔值、settings 对象，或包含 settings 的插件对象，方便各模块复用。
type VerboseLogSource =
	| boolean
	| Pick<ObakSettings, "enableVerboseLogging">
	| { settings: Pick<ObakSettings, "enableVerboseLogging"> };

/**
 * 在开启详细日志时输出调试信息。
 */
export function logVerbose(
	source: VerboseLogSource,
	message: string,
	details?: unknown,
): void {
	if (!isVerboseLoggingEnabled(source)) {
		return;
	}

	if (details === undefined) {
		console.debug(LOG_PREFIX, message);
		return;
	}

	console.debug(LOG_PREFIX, message, details);
}

/**
 * 始终输出错误日志。
 */
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
