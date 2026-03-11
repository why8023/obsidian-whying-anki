import { Notice, Plugin, TFile } from "obsidian";
import { logError, logVerbose } from "./logger";
import { buildNoticeMessage, formatParseError } from "./notices";
import { syncMarkdownFileToAnki } from "./sync-runner";
import type { LocalRefreshResult, ObakPluginApi, SyncToAnkiResult } from "./types";

const AUTO_SYNC_DELAY_MS = 5000;
const NOTICE_AUTO_HIDE_MS = 7000;
const NOTICE_PERSIST_MS = 0;

type AutoSyncReason = "edit-stopped" | "file-left";

interface PendingAutoSync {
	reason: AutoSyncReason;
	timeoutId: number;
}

export class AutoSyncController {
	private activeFilePath: string | null;
	private readonly pendingByPath = new Map<string, PendingAutoSync>();

	constructor(private readonly plugin: Plugin & ObakPluginApi) {
		this.activeFilePath = getMarkdownFilePath(this.plugin.app.workspace.getActiveFile());
	}

	onMarkdownFileModify(file: TFile): void {
		if (!this.plugin.settings.autoSyncCurrentFile) {
			return;
		}

		if (file.path !== this.activeFilePath) {
			return;
		}

		this.schedule(file.path, "edit-stopped");
	}

	onActiveFileChange(file: TFile | null): void {
		const nextPath = getMarkdownFilePath(file);
		if (nextPath) {
			this.cancel(nextPath, "file became active again");
		}

		const previousPath = this.activeFilePath;
		this.activeFilePath = nextPath;

		if (!previousPath || previousPath === nextPath) {
			return;
		}

		if (!this.plugin.settings.autoSyncCurrentFile || !this.isFileDirty(previousPath)) {
			return;
		}

		this.schedule(previousPath, "file-left");
	}

	onMarkdownFileDelete(filePath: string): void {
		this.cancel(filePath, "file was deleted");

		if (this.activeFilePath === filePath) {
			this.activeFilePath = null;
		}
	}

	onMarkdownFileRename(file: TFile, oldPath: string): void {
		this.cancel(oldPath, "file was renamed");

		if (this.activeFilePath === oldPath) {
			this.activeFilePath = file.path;
		}

		if (!this.plugin.settings.autoSyncCurrentFile) {
			return;
		}

		if (file.path !== this.activeFilePath) {
			return;
		}

		this.schedule(file.path, "edit-stopped");
	}

	destroy(): void {
		for (const pending of this.pendingByPath.values()) {
			window.clearTimeout(pending.timeoutId);
		}

		this.pendingByPath.clear();
	}

	private schedule(filePath: string, reason: AutoSyncReason): void {
		this.cancel(filePath);

		const timeoutId = window.setTimeout(() => {
			this.pendingByPath.delete(filePath);
			void this.execute(filePath, reason);
		}, AUTO_SYNC_DELAY_MS);

		this.pendingByPath.set(filePath, { reason, timeoutId });
		logVerbose(this.plugin, `Scheduled auto sync for ${filePath}.`, {
			delayMs: AUTO_SYNC_DELAY_MS,
			reason,
		});
	}

	private cancel(filePath: string, detail?: string): void {
		const pending = this.pendingByPath.get(filePath);
		if (!pending) {
			return;
		}

		window.clearTimeout(pending.timeoutId);
		this.pendingByPath.delete(filePath);
		logVerbose(this.plugin, `Cancelled pending auto sync for ${filePath}.`, {
			detail,
			reason: pending.reason,
		});
	}

	private async execute(filePath: string, reason: AutoSyncReason): Promise<void> {
		if (!this.plugin.settings.autoSyncCurrentFile) {
			logVerbose(this.plugin, `Skipped auto sync for ${filePath} because it is disabled.`);
			return;
		}

		if (!this.isFileDirty(filePath)) {
			logVerbose(this.plugin, `Skipped auto sync for clean file ${filePath}.`);
			return;
		}

		const file = this.plugin.app.vault.getFileByPath(filePath);
		if (!isMarkdownFile(file)) {
			logVerbose(this.plugin, `Skipped auto sync for missing file ${filePath}.`, {
				reason,
			});
			return;
		}

		const started = await this.plugin.runExclusiveSync(
			`auto sync for ${file.path}`,
			async () => {
				logVerbose(this.plugin, `Starting auto sync for ${file.path}.`, { reason });

				try {
					const result = await syncMarkdownFileToAnki(this.plugin, file);
					reportAutoSyncResult(this.plugin, file, result);
					logVerbose(this.plugin, `Finished auto sync for ${file.path}.`, {
						reason,
						result,
					});
				} catch (error) {
					logError(`Auto sync failed for ${file.path}.`, error);
					new Notice(
						buildNoticeMessage({
							label: "Auto sync",
							title: "Current file auto-sync failed",
							summary: asErrorMessage(error),
							tone: "danger",
						}),
						NOTICE_PERSIST_MS,
					);
				}
			},
		);

		if (started !== null) {
			return;
		}

		logVerbose(this.plugin, `Deferred auto sync for ${file.path} because another sync is running.`, {
			reason,
		});

		if (this.isFileDirty(file.path)) {
			this.schedule(file.path, reason);
		}
	}

	private isFileDirty(filePath: string): boolean {
		return this.plugin.getDirtyFilePaths().includes(filePath);
	}
}

function reportAutoSyncResult(
	plugin: ObakPluginApi,
	file: TFile,
	result: SyncToAnkiResult,
): void {
	logParseErrors(result.parseErrors);
	logRuntimeErrors(result.runtimeErrors);

	const issues = result.parseErrors.length + result.runtimeErrors.length;
	const changeCount = result.cardsCreated + result.cardsUpdated + result.cardsDeleted;

	new Notice(
		buildNoticeMessage({
			label: "Auto sync",
			title:
				issues === 0
					? "Current file auto-synced"
					: "Current file auto-sync finished with issues",
			summary: buildAutoSyncSummary(file, result, issues, changeCount),
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
	file: TFile,
	result: SyncToAnkiResult,
	issues: number,
	changeCount: number,
): string {
	if (issues > 0) {
		return `Auto sync finished for ${file.basename}. Some cards need attention.`;
	}

	if (result.cardsProcessed === 0) {
		return `Auto sync finished for ${file.basename}. No cards were found.`;
	}

	if (changeCount === 0) {
		return `Auto sync finished for ${file.basename}. No card changes were needed.`;
	}

	return `Auto sync finished for ${file.basename}. Applied ${changeCount} change(s).`;
}

function collectIssueMessages(result: LocalRefreshResult): string[] {
	return [
		...result.parseErrors.map(formatParseError),
		...result.runtimeErrors,
	];
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

function getMarkdownFilePath(file: TFile | null): string | null {
	return isMarkdownFile(file) ? file.path : null;
}

function isMarkdownFile(file: TFile | null): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
