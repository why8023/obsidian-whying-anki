import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { logError, logVerbose } from "../logger";
import { buildNoticeMessage, formatParseError, SyncProgressNotice } from "../notices";
import {
	rebuildSyncIndex,
	refreshLocalMetadataForFiles,
	syncCardsToAnki,
	syncChangedCardsToAnki,
	validateMarkdownFile,
} from "../sync-runner";
import { registerEditorCommands } from "./editor-commands";
import type {
	LocalRefreshResult,
	SyncToAnkiResult,
	ObakPluginApi,
} from "../types";

/**
 * 注册所有面向用户的命令。
 * 命令层只负责触发具体流程、展示 notice 和记录日志，不承载同步算法本身。
 */
export function registerCommands(plugin: Plugin & ObakPluginApi): void {
	registerEditorCommands(plugin);

	plugin.addCommand({
		id: "sync-cards-to-anki",
		name: "Sync cards to Anki",
		callback: () => {
			void runSyncCardsToAnki(plugin);
		},
	});

	plugin.addCommand({
		id: "sync-changed-cards-to-anki",
		name: "Sync changed cards to Anki",
		callback: () => {
			void runSyncChangedCardsToAnki(plugin);
		},
	});

	plugin.addCommand({
		id: "validate-card-syntax-current-file",
		name: "Validate card syntax in current file",
		checkCallback: (checking) => {
			const file = getActiveMarkdownFile(plugin);
			if (!file) {
				return false;
			}

			if (!checking) {
				void runValidateCurrentFile(plugin, file);
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "refresh-card-metadata-current-file",
		name: "Refresh card metadata in current file",
		checkCallback: (checking) => {
			const file = getActiveMarkdownFile(plugin);
			if (!file) {
				return false;
			}

			if (!checking) {
				void runRefreshCurrentFile(plugin, file);
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "rebuild-sync-index",
		name: "Rebuild sync index",
		callback: () => {
			void runRebuildSyncIndex(plugin);
		},
	});
}

async function runValidateCurrentFile(
	plugin: Plugin & ObakPluginApi,
	file: TFile,
): Promise<void> {
	// 只做语法扫描，不会改 Anki，也不会改本地索引。
	logVerbose(plugin, `Validating card syntax for ${file.path}.`);
	const scannedFile = await validateMarkdownFile(plugin, file);
	const issueCount = scannedFile.errors.length;

	logParseErrors(scannedFile.errors);
	logVerbose(plugin, `Validation finished for ${file.path}.`, {
		cards: scannedFile.cards.length,
		issues: issueCount,
	});
	new Notice(
		buildNoticeMessage(
			issueCount === 0
				? `Validated ${scannedFile.cards.length} card(s) with no syntax errors.`
				: `Validated ${scannedFile.cards.length} card(s); found ${issueCount} syntax issue(s).`,
			scannedFile.errors.map(formatParseError),
			plugin.settings.showDetailedErrorNotices,
		),
		7000,
	);
}

async function runRefreshCurrentFile(
	plugin: Plugin & ObakPluginApi,
	file: TFile,
): Promise<void> {
	// 刷新本地元数据会补齐 UID/rev/noteId 等结束标记，但不访问 Anki。
	logVerbose(plugin, `Refreshing local metadata for ${file.path}.`);
	const result = await refreshLocalMetadataForFiles(plugin, [file]);
	reportResult(
		"Updated current file metadata",
		result,
		plugin.settings.showDetailedErrorNotices,
	);
	logVerbose(plugin, `Finished refreshing local metadata for ${file.path}.`, result);
}

async function runRebuildSyncIndex(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	// 全量重建索引通常用于恢复索引异常，或配置变化后强制重扫。
	logVerbose(plugin, "Rebuilding sync index.");
	const result = await rebuildSyncIndex(plugin);
	reportResult(
		"Rebuilt sync index",
		result,
		plugin.settings.showDetailedErrorNotices,
	);
	logVerbose(plugin, "Finished rebuilding sync index.", result);
}

async function runSyncCardsToAnki(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	// 全量同步会扫描当前 vault 的所有 Markdown 文件。
	const progressNotice = new SyncProgressNotice("Syncing cards to Anki");
	logVerbose(plugin, "Starting full sync to Anki.");

	try {
		const result = await syncCardsToAnki(plugin, {
			onProgress: (progress) => progressNotice.update(progress),
		});
		reportSyncResult(plugin, result, "Synced");
	} catch (error) {
		logError("Full sync failed.", error);
		new Notice(`Sync failed: ${asErrorMessage(error)}`, 7000);
	} finally {
		progressNotice.hide();
	}
}

async function runSyncChangedCardsToAnki(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	// 增量同步只处理脏文件、最近改动文件，或索引判断必须重扫的文件。
	const progressNotice = new SyncProgressNotice("Incremental Anki sync");
	logVerbose(plugin, "Starting incremental sync to Anki.");

	try {
		const result = await syncChangedCardsToAnki(plugin, {
			onProgress: (progress) => progressNotice.update(progress),
		});
		reportSyncResult(plugin, result, "Incremental sync");
	} catch (error) {
		logError("Incremental sync failed.", error);
		new Notice(`Incremental sync failed: ${asErrorMessage(error)}`, 7000);
	} finally {
		progressNotice.hide();
	}
}

function reportResult(
	prefix: string,
	result: LocalRefreshResult,
	showDetailedErrors = false,
): void {
	// notice 面向用户，console 面向排查问题；两边都保留输出。
	logParseErrors(result.parseErrors);
	logRuntimeErrors(result.runtimeErrors);

	const issues = result.parseErrors.length + result.runtimeErrors.length;
	const message =
		issues === 0
			? `${prefix}: ${result.cardsProcessed} card(s), ${result.filesRewritten} file rewrite(s).`
			: `${prefix}: ${result.cardsProcessed} card(s), ${issues} issue(s), ${result.filesRewritten} file rewrite(s).`;

	new Notice(
		buildNoticeMessage(message, collectIssueMessages(result), showDetailedErrors),
		7000,
	);
}

function reportSyncResult(
	plugin: Plugin & ObakPluginApi,
	result: SyncToAnkiResult,
	prefix: string,
): void {
	// 同步结果会额外展示创建、更新、删除、未变化的卡片统计。
	logParseErrors(result.parseErrors);
	logRuntimeErrors(result.runtimeErrors);

	const issues = result.parseErrors.length + result.runtimeErrors.length;
	const message =
		issues === 0
			? `${prefix} ${result.cardsProcessed} card(s): ${result.cardsCreated} created, ${result.cardsUpdated} updated, ${result.cardsDeleted} deleted, ${result.cardsUnchanged} unchanged.`
			: `${prefix} ${result.cardsProcessed} card(s): ${result.cardsCreated} created, ${result.cardsUpdated} updated, ${result.cardsDeleted} deleted, ${issues} issue(s).`;

	new Notice(
		buildNoticeMessage(
			message,
			collectIssueMessages(result),
			plugin.settings.showDetailedErrorNotices,
		),
		7000,
	);
	logVerbose(plugin, `${prefix} summary.`, result);
}

function logParseErrors(errors: LocalRefreshResult["parseErrors"]): void {
	for (const error of errors) {
		logError(`${error.filePath}:${error.line} ${error.message}`);
	}
}

function logRuntimeErrors(errors: string[]): void {
	for (const error of errors) {
		logError(error);
	}
}

function collectIssueMessages(result: LocalRefreshResult): string[] {
	return [
		...result.parseErrors.map(formatParseError),
		...result.runtimeErrors,
	];
}

function getActiveMarkdownFile(plugin: ObakPluginApi): TFile | null {
	// 只有当前活动视图是 MarkdownView 时，相关命令才应该启用。
	const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	return view?.file ?? null;
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
