import { Notice, Plugin, TFile } from "obsidian";
import { logError, logVerbose } from "./logger";
import { buildNoticeMessage, formatParseError } from "./notices";
import { syncChangedCardsToAnki } from "./sync-runner";
import type { LocalRefreshResult, ObakPluginApi, SyncToAnkiResult } from "./types";

const NOTICE_AUTO_HIDE_MS = 7000;
const NOTICE_PERSIST_MS = 0;

type AutoSyncReason = "edit-stopped" | "file-left" | "vault-change";

interface PendingAutoSync {
	reason: AutoSyncReason;
	timeoutId: number;
}

export class AutoSyncController {
	private activeFilePath: string | null;
	private pending: PendingAutoSync | null = null;

	constructor(private readonly plugin: Plugin & ObakPluginApi) {
		this.activeFilePath = getMarkdownFilePath(this.plugin.app.workspace.getActiveFile());
	}

	onMarkdownFileModify(file: TFile): void {
		if (!this.plugin.settings.autoSyncEnabled) {
			return;
		}

		if (file.path !== this.activeFilePath) {
			return;
		}

		this.schedule("edit-stopped", file.path);
	}

	onActiveFileChange(file: TFile | null): void {
		const nextPath = getMarkdownFilePath(file);
		const previousPath = this.activeFilePath;
		this.activeFilePath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		if (!this.plugin.settings.autoSyncEnabled || !this.isFileDirty(previousPath)) {
			return;
		}

		this.schedule("file-left", previousPath);
	}

	onMarkdownFileDelete(filePath: string): void {
		if (this.activeFilePath === filePath) {
			this.activeFilePath = null;
		}

		if (!this.plugin.settings.autoSyncEnabled) {
			return;
		}

		this.schedule("vault-change", filePath);
	}

	onMarkdownFileRename(file: TFile, oldPath: string): void {
		if (this.activeFilePath === oldPath) {
			this.activeFilePath = file.path;
		}

		if (!this.plugin.settings.autoSyncEnabled) {
			return;
		}

		this.schedule("vault-change", file.path);
	}

	destroy(): void {
		if (!this.pending) {
			return;
		}

		window.clearTimeout(this.pending.timeoutId);
		this.pending = null;
	}

	private schedule(reason: AutoSyncReason, sourcePath?: string): void {
		this.cancel();
		const delayMs = getAutoSyncDelayMs(this.plugin);

		const timeoutId = window.setTimeout(() => {
			this.pending = null;
			void this.execute(reason, sourcePath);
		}, delayMs);

		this.pending = { reason, timeoutId };
		logVerbose(this.plugin, "Scheduled auto sync.", {
			delayMs,
			reason,
			sourcePath,
		});
	}

	private cancel(): void {
		if (!this.pending) {
			return;
		}

		window.clearTimeout(this.pending.timeoutId);
		this.pending = null;
	}

	private async execute(reason: AutoSyncReason, sourcePath?: string): Promise<void> {
		if (!this.plugin.settings.autoSyncEnabled) {
			logVerbose(this.plugin, "Skipped auto sync because it is disabled.");
			return;
		}

		if (!this.hasPendingWork()) {
			logVerbose(this.plugin, "Skipped auto sync because there is no pending work.", {
				reason,
				sourcePath,
			});
			return;
		}

		const started = await this.plugin.runExclusiveSync("auto incremental sync", async () => {
			logVerbose(this.plugin, "Starting auto incremental sync.", {
				reason,
				sourcePath,
			});

			try {
				const result = await syncChangedCardsToAnki(this.plugin);
				reportAutoSyncResult(this.plugin, result);
				logVerbose(this.plugin, "Finished auto incremental sync.", {
					reason,
					sourcePath,
					result,
				});
			} catch (error) {
				logError("Auto incremental sync failed.", error);
				new Notice(
					buildNoticeMessage({
						label: "Auto sync",
						title: "Auto incremental sync failed",
						summary: asErrorMessage(error),
						tone: "danger",
					}),
					NOTICE_PERSIST_MS,
				);
			}
		});

		if (started !== null) {
			return;
		}

		logVerbose(this.plugin, "Deferred auto incremental sync because another sync is running.", {
			reason,
			sourcePath,
		});

		if (this.hasPendingWork()) {
			this.schedule(reason, sourcePath);
		}
	}

	private hasPendingWork(): boolean {
		return (
			this.plugin.getDirtyFilePaths().length > 0 ||
			this.plugin.indexStore.getDeletedFilePaths().length > 0 ||
			this.plugin.indexStore.getPendingDeleteNoteIds().length > 0 ||
			this.plugin.indexStore.getPendingSyncFilePaths().length > 0
		);
	}

	private isFileDirty(filePath: string): boolean {
		return this.plugin.getDirtyFilePaths().includes(filePath);
	}
}

function reportAutoSyncResult(
	plugin: ObakPluginApi,
	result: SyncToAnkiResult,
): void {
	logParseErrors(result.parseErrors);
	logRuntimeErrors(result.runtimeErrors);

	const issues = result.parseErrors.length + result.runtimeErrors.length;
	const changeCount = result.cardsCreated + result.cardsUpdated + result.cardsDeleted;

	new Notice(
		buildNoticeMessage({
			label: "Auto sync",
			title: issues === 0 ? "Auto sync finished" : "Auto sync finished with issues",
			summary: buildAutoSyncSummary(result, issues, changeCount),
			metrics: [
				{
					label: "Files",
					value: String(result.filesProcessed),
				},
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
					label: "Issues",
					value: String(issues),
					tone: issues === 0 ? "positive" : "warning",
				},
			],
			issues: collectIssueMessages(result),
			showDetailedIssues: plugin.settings.showDetailedErrorNotices,
			tone: issues === 0 ? "success" : "warning",
		}),
		issues === 0 ? NOTICE_AUTO_HIDE_MS : NOTICE_PERSIST_MS,
	);
}

function buildAutoSyncSummary(
	result: SyncToAnkiResult,
	issues: number,
	changeCount: number,
): string {
	if (issues > 0) {
		return "Auto sync finished. Some cards need attention.";
	}

	if (result.filesProcessed === 0 && changeCount === 0) {
		return "Auto sync found no pending vault changes.";
	}

	if (changeCount === 0) {
		return `Auto sync checked ${result.filesProcessed} file(s). No card changes were needed.`;
	}

	return `Auto sync checked ${result.filesProcessed} file(s) and applied ${changeCount} change(s).`;
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

function getMarkdownFilePath(file: TFile | null): string | null {
	return isMarkdownFile(file) ? file.path : null;
}

function isMarkdownFile(file: TFile | null): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getAutoSyncDelayMs(plugin: ObakPluginApi): number {
	const delaySeconds = plugin.settings.autoSyncDelaySeconds;
	return Number.isInteger(delaySeconds) && delaySeconds >= 1
		? delaySeconds * 1000
		: 5000;
}
