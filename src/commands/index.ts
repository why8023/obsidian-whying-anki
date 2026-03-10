import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
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
	const scannedFile = await validateMarkdownFile(plugin, file);
	const issueCount = scannedFile.errors.length;

	logParseErrors(scannedFile.errors);
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
	const result = await refreshLocalMetadataForFiles(plugin, [file]);
	reportResult(
		"Updated current file metadata",
		result,
		plugin.settings.showDetailedErrorNotices,
	);
}

async function runRebuildSyncIndex(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	const result = await rebuildSyncIndex(plugin);
	reportResult(
		"Rebuilt sync index",
		result,
		plugin.settings.showDetailedErrorNotices,
	);
}

async function runSyncCardsToAnki(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	const progressNotice = new SyncProgressNotice("Syncing cards to Anki");

	try {
		const result = await syncCardsToAnki(plugin, {
			onProgress: (progress) => progressNotice.update(progress),
		});
		reportSyncResult(plugin, result, "Synced");
	} catch (error) {
		console.error("[obsidian-obak]", error);
		new Notice(`Sync failed: ${asErrorMessage(error)}`, 7000);
	} finally {
		progressNotice.hide();
	}
}

async function runSyncChangedCardsToAnki(
	plugin: Plugin & ObakPluginApi,
): Promise<void> {
	const progressNotice = new SyncProgressNotice("Incremental Anki sync");

	try {
		const result = await syncChangedCardsToAnki(plugin, {
			onProgress: (progress) => progressNotice.update(progress),
		});
		reportSyncResult(plugin, result, "Incremental sync");
	} catch (error) {
		console.error("[obsidian-obak]", error);
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
}

function logParseErrors(errors: LocalRefreshResult["parseErrors"]): void {
	for (const error of errors) {
		console.error(
			`[obsidian-obak] ${error.filePath}:${error.line} ${error.message}`,
		);
	}
}

function logRuntimeErrors(errors: string[]): void {
	for (const error of errors) {
		console.error(`[obsidian-obak] ${error}`);
	}
}

function collectIssueMessages(result: LocalRefreshResult): string[] {
	return [
		...result.parseErrors.map(formatParseError),
		...result.runtimeErrors,
	];
}

function getActiveMarkdownFile(plugin: ObakPluginApi): TFile | null {
	const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	return view?.file ?? null;
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
