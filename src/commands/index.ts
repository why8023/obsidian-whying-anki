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

const NOTICE_AUTO_HIDE_MS = 7000;
const NOTICE_PERSIST_MS = 0;

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
			{
				label: "Validation",
				title:
					issueCount === 0
						? "Current file validated"
						: "Validation finished with issues",
				summary:
					issueCount === 0
						? "No syntax errors were found in the current file."
						: "Fix the reported syntax errors before syncing this file.",
				metrics: [
					{
						label: "Cards",
						value: String(scannedFile.cards.length),
					},
					{
						label: "Issues",
						value: String(issueCount),
						tone: issueCount === 0 ? "positive" : "warning",
					},
				],
				issues: scannedFile.errors.map(formatParseError),
				showDetailedIssues: plugin.settings.showDetailedErrorNotices,
				tone: issueCount === 0 ? "success" : "warning",
			},
		),
		getNoticeDuration(issueCount > 0),
	);
}

async function runRefreshCurrentFile(
	plugin: Plugin & ObakPluginApi,
	file: TFile,
): Promise<void> {
	// 刷新本地元数据会更新 card-end 中的 id 标记，但不访问 Anki。
	logVerbose(plugin, `Refreshing local metadata for ${file.path}.`);
	const result = await refreshLocalMetadataForFiles(plugin, [file]);
	reportResult(
		{
			label: "Metadata refresh",
			successTitle: "Current file metadata refreshed",
			issueTitle: "Metadata refresh finished with issues",
			successSummary: "Card metadata markers in the current file are up to date.",
			issueSummary: "Some metadata could not be refreshed cleanly.",
		},
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
		{
			label: "Sync index",
			successTitle: "Sync index rebuilt",
			issueTitle: "Sync index rebuild finished with issues",
			successSummary: "The local sync index has been rebuilt from vault data.",
			issueSummary: "Some files could not be fully indexed.",
		},
		result,
		plugin.settings.showDetailedErrorNotices,
	);
	logVerbose(plugin, "Finished rebuilding sync index.", result);
}

async function runSyncCardsToAnki(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	// 全量同步会扫描当前 vault 的所有 Markdown 文件。
	const started = await plugin.runExclusiveSync("full sync", async () => {
		const progressNotice = new SyncProgressNotice("Syncing cards to Anki");
		logVerbose(plugin, "Starting full sync to Anki.");

		try {
			const result = await syncCardsToAnki(plugin, {
				onProgress: (progress) => progressNotice.update(progress),
			});
			reportSyncResult(plugin, result, "Full sync");
		} catch (error) {
			logError("Full sync failed.", error);
			new Notice(
				buildNoticeMessage({
					label: "Anki sync",
					title: "Full sync failed",
					summary: asErrorMessage(error),
					tone: "danger",
				}),
				NOTICE_PERSIST_MS,
			);
		} finally {
			progressNotice.hide();
		}

		return true;
	});

	if (started === null) {
		showSyncBusyNotice("Full sync");
	}
}

async function runSyncChangedCardsToAnki(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	// 增量同步只处理脏文件、最近改动文件，或索引判断必须重扫的文件。
	const started = await plugin.runExclusiveSync("incremental sync", async () => {
		const progressNotice = new SyncProgressNotice("Incremental Anki sync");
		logVerbose(plugin, "Starting incremental sync to Anki.");

		try {
			const result = await syncChangedCardsToAnki(plugin, {
				onProgress: (progress) => progressNotice.update(progress),
			});
			reportSyncResult(plugin, result, "Incremental sync");
		} catch (error) {
			logError("Incremental sync failed.", error);
			new Notice(
				buildNoticeMessage({
					label: "Anki sync",
					title: "Incremental sync failed",
					summary: asErrorMessage(error),
					tone: "danger",
				}),
				NOTICE_PERSIST_MS,
			);
		} finally {
			progressNotice.hide();
		}

		return true;
	});

	if (started === null) {
		showSyncBusyNotice("Incremental sync");
	}
}

interface ResultNoticeConfig {
	label: string;
	successTitle: string;
	issueTitle: string;
	successSummary: string;
	issueSummary: string;
}

function reportResult(
	config: ResultNoticeConfig,
	result: LocalRefreshResult,
	showDetailedErrors = false,
): void {
	// notice 面向用户，console 面向排查问题；两边都保留输出。
	logParseErrors(result.parseErrors);
	logRuntimeErrors(result.runtimeErrors);

	const issues = result.parseErrors.length + result.runtimeErrors.length;

	new Notice(
		buildNoticeMessage({
			label: config.label,
			title: issues === 0 ? config.successTitle : config.issueTitle,
			summary: issues === 0 ? config.successSummary : config.issueSummary,
			metrics: [
				{
					label: "Files",
					value: String(result.filesProcessed),
				},
				{
					label: "Cards",
					value: String(result.cardsProcessed),
				},
				{
					label: "Rewritten",
					value: String(result.filesRewritten),
					tone: result.filesRewritten > 0 ? "positive" : "neutral",
				},
				{
					label: "Issues",
					value: String(issues),
					tone: issues === 0 ? "positive" : "warning",
				},
			],
			issues: collectIssueMessages(result),
			showDetailedIssues: showDetailedErrors,
			tone: issues === 0 ? "success" : "warning",
		}),
		getNoticeDuration(issues > 0),
	);
}

function reportSyncResult(
	plugin: Plugin & ObakPluginApi,
	result: SyncToAnkiResult,
	label: string,
): void {
	// 同步结果会额外展示创建、更新、删除、未变化的卡片统计。
	logParseErrors(result.parseErrors);
	logRuntimeErrors(result.runtimeErrors);

	const issues = result.parseErrors.length + result.runtimeErrors.length;

	new Notice(
		buildNoticeMessage({
			label: "Anki sync",
			title: issues === 0 ? `${label} complete` : `${label} finished with issues`,
			summary:
				issues === 0
					? "Anki changes were applied successfully."
					: "Some cards could not be synced cleanly.",
			metrics: [
				{
					label: "Processed",
					value: String(result.cardsProcessed),
				},
				{
					label: "Created",
					value: String(result.cardsCreated),
					tone: result.cardsCreated > 0 ? "positive" : "neutral",
				},
				{
					label: "Updated",
					value: String(result.cardsUpdated),
					tone: result.cardsUpdated > 0 ? "positive" : "neutral",
				},
				{
					label: "Deleted",
					value: String(result.cardsDeleted),
				},
				{
					label: "Unchanged",
					value: String(result.cardsUnchanged),
				},
				{
					label: "Issues",
					value: String(issues),
					tone: issues === 0 ? "positive" : "warning",
				},
			],
			issues: collectIssueMessages(result),
			showDetailedIssues: plugin.settings.showDetailedErrorNotices,
			tone: issues === 0 ? "success" : "warning",
		}),
		getNoticeDuration(issues > 0),
	);
	logVerbose(plugin, `${label} summary.`, result);
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

function getNoticeDuration(hasIssues: boolean): number {
	return hasIssues ? NOTICE_PERSIST_MS : NOTICE_AUTO_HIDE_MS;
}

function showSyncBusyNotice(label: string): void {
	new Notice(
		buildNoticeMessage({
			label: "Anki sync",
			title: `${label} skipped`,
			summary: "Another sync is already running. Wait for it to finish before starting a new one.",
			tone: "warning",
		}),
		NOTICE_AUTO_HIDE_MS,
	);
}
