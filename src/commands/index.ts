import { MarkdownView, Notice, Plugin, TFile } from "obsidian";
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
	WhyingAnkiPluginApi,
} from "../types";

export function registerCommands(plugin: Plugin & WhyingAnkiPluginApi): void {
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
	plugin: WhyingAnkiPluginApi,
	file: TFile,
): Promise<void> {
	const scannedFile = await validateMarkdownFile(plugin, file);
	const issueCount = scannedFile.errors.length;

	logParseErrors(scannedFile.errors);
	new Notice(
		issueCount === 0
			? `Validated ${scannedFile.cards.length} card(s) with no syntax errors.`
			: `Validated ${scannedFile.cards.length} card(s); found ${issueCount} syntax issue(s).`,
	);
}

async function runRefreshCurrentFile(
	plugin: Plugin & WhyingAnkiPluginApi,
	file: TFile,
): Promise<void> {
	const result = await refreshLocalMetadataForFiles(plugin, [file]);
	reportResult("Updated current file metadata", result);
}

async function runRebuildSyncIndex(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<void> {
	const result = await rebuildSyncIndex(plugin);
	reportResult("Rebuilt sync index", result);
}

async function runSyncCardsToAnki(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<void> {
	const result = await syncCardsToAnki(plugin);
	reportSyncResult(result, "Synced");
}

async function runSyncChangedCardsToAnki(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<void> {
	const result = await syncChangedCardsToAnki(plugin);
	reportSyncResult(result, "Incremental sync");
}

function reportResult(prefix: string, result: LocalRefreshResult): void {
	logParseErrors(result.parseErrors);
	logRuntimeErrors(result.runtimeErrors);

	const issues = result.parseErrors.length + result.runtimeErrors.length;
	const message =
		issues === 0
			? `${prefix}: ${result.cardsProcessed} card(s), ${result.filesRewritten} file rewrite(s).`
			: `${prefix}: ${result.cardsProcessed} card(s), ${issues} issue(s), ${result.filesRewritten} file rewrite(s).`;

	new Notice(message, 6000);
}

function reportSyncResult(
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

	new Notice(message, 7000);
}

function logParseErrors(errors: LocalRefreshResult["parseErrors"]): void {
	for (const error of errors) {
		console.error(
			`[obsidian-whying-anki] ${error.filePath}:${error.line} ${error.message}`,
		);
	}
}

function logRuntimeErrors(errors: string[]): void {
	for (const error of errors) {
		console.error(`[obsidian-whying-anki] ${error}`);
	}
}

function getActiveMarkdownFile(plugin: WhyingAnkiPluginApi): TFile | null {
	const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	return view?.file ?? null;
}
