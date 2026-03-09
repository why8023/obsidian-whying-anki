import type { Plugin, TFile } from "obsidian";
import { createEmptyPluginIndex, IndexStore } from "./index-store";
import { computeCardRevision, generateCardUid } from "./normalize";
import { scanMarkdownFile, scanMarkdownFiles } from "./scanner";
import { serializeCardEnd } from "./syntax";
import type {
	LocalRefreshResult,
	ParsedCard,
	ScannedFile,
	WhyingAnkiPluginApi,
} from "./types";

interface CardRewrite {
	startOffset: number;
	endOffset: number;
	replacement: string;
}

interface PreparedScannedFile {
	scannedFile: ScannedFile;
	finalCards: ParsedCard[];
	rewrites: CardRewrite[];
}

export async function validateMarkdownFile(
	plugin: WhyingAnkiPluginApi,
	file: TFile,
): Promise<ScannedFile> {
	return scanMarkdownFile(plugin.app, file, plugin.settings);
}

export async function refreshLocalMetadataForFiles(
	plugin: Plugin & WhyingAnkiPluginApi,
	files: TFile[],
): Promise<LocalRefreshResult> {
	const scannedFiles = await scanMarkdownFiles(plugin.app, files, plugin.settings);
	const result = createResult();

	for (const scannedFile of scannedFiles) {
		result.filesProcessed += 1;
		result.cardsProcessed += scannedFile.cards.length;
		result.parseErrors.push(...scannedFile.errors);

		const prepared = await prepareScannedFile(scannedFile);
		const rewritten = await commitPreparedFile(plugin, prepared, result.runtimeErrors);
		if (!rewritten && prepared.rewrites.length > 0) {
			continue;
		}

		if (rewritten) {
			result.filesRewritten += 1;
		}

		plugin.indexStore.setFileCards(scannedFile.file.path, prepared.finalCards, {
			preserveUnseen: true,
		});
		plugin.indexStore.clearDirtyFile(scannedFile.file.path);
	}

	await plugin.savePluginData();
	return result;
}

export async function rebuildSyncIndex(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<LocalRefreshResult> {
	const files = plugin.app.vault.getMarkdownFiles();
	const scannedFiles = await scanMarkdownFiles(plugin.app, files, plugin.settings);
	const rebuiltIndex = createEmptyPluginIndex();
	const rebuiltStore = new IndexStore(rebuiltIndex);
	const result = createResult();

	rebuiltIndex.pendingDeleteNoteIds = plugin.indexStore.getPendingDeleteNoteIds();
	rebuiltIndex.lastFullReconcileAt = Date.now();

	for (const scannedFile of scannedFiles) {
		result.filesProcessed += 1;
		result.cardsProcessed += scannedFile.cards.length;
		result.parseErrors.push(...scannedFile.errors);

		const prepared = await prepareScannedFile(scannedFile);
		const rewritten = await commitPreparedFile(plugin, prepared, result.runtimeErrors);
		if (!rewritten && prepared.rewrites.length > 0) {
			continue;
		}

		if (rewritten) {
			result.filesRewritten += 1;
		}

		rebuiltStore.setFileCards(scannedFile.file.path, prepared.finalCards);
	}

	plugin.indexStore.replace({
		...rebuiltStore.getSnapshot(),
		pendingDeleteNoteIds: rebuiltIndex.pendingDeleteNoteIds,
		lastFullReconcileAt: rebuiltIndex.lastFullReconcileAt,
	});
	await plugin.savePluginData();
	return result;
}

function createResult(): LocalRefreshResult {
	return {
		filesProcessed: 0,
		filesRewritten: 0,
		cardsProcessed: 0,
		parseErrors: [],
		runtimeErrors: [],
	};
}

async function prepareScannedFile(
	scannedFile: ScannedFile,
): Promise<PreparedScannedFile> {
	const preparedCards = await Promise.all(
		scannedFile.cards.map(async (card) => {
			const uid = card.uid ?? generateCardUid();
			const rev = await computeCardRevision({
				effectiveDeck: card.effectiveDeck,
				effectiveTags: card.effectiveTags,
				frontNormalized: card.frontNormalized,
				backNormalized: card.backNormalized,
			});

			const finalCard: ParsedCard = {
				...card,
				uid,
				rev,
			};
			const replacement = serializeCardEnd({
				uid,
				noteId: card.noteId,
				rev,
			});

			return {
				card: finalCard,
				rewrite:
					card.originalEndMarker === replacement
						? null
						: {
								startOffset: card.endMarkerStartOffset,
								endOffset: card.endMarkerEndOffset,
								replacement,
						  },
			};
		}),
	);

	return {
		scannedFile,
		finalCards: preparedCards.map((entry) => entry.card),
		rewrites: preparedCards
			.map((entry) => entry.rewrite)
			.filter((rewrite): rewrite is CardRewrite => rewrite !== null),
	};
}

async function commitPreparedFile(
	plugin: WhyingAnkiPluginApi,
	prepared: PreparedScannedFile,
	runtimeErrors: string[],
): Promise<boolean> {
	if (prepared.rewrites.length === 0) {
		return false;
	}

	try {
		await plugin.app.vault.process(prepared.scannedFile.file, (current) => {
			if (current !== prepared.scannedFile.text) {
				throw new Error(
					`File changed during rewrite: ${prepared.scannedFile.file.path}`,
				);
			}

			let rewritten = current;
			for (const rewrite of [...prepared.rewrites].sort(
				(left, right) => right.startOffset - left.startOffset,
			)) {
				rewritten =
					rewritten.slice(0, rewrite.startOffset) +
					rewrite.replacement +
					rewritten.slice(rewrite.endOffset);
			}

			return rewritten;
		});

		return true;
	} catch (error) {
		runtimeErrors.push(asErrorMessage(error));
		return false;
	}
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
