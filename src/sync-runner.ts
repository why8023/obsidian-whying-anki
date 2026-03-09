import type { Plugin, TFile } from "obsidian";
import { AnkiClient } from "./anki-client";
import { createEmptyPluginIndex, IndexStore } from "./index-store";
import { computeCardRevision, generateCardUid, normalizeCardUid } from "./normalize";
import { scanMarkdownFile, scanMarkdownFiles } from "./scanner";
import { serializeCardEnd } from "./syntax";
import type {
	CardIndexRecord,
	LocalRefreshResult,
	ParsedCard,
	PluginIndex,
	ScannedFile,
	SyncToAnkiResult,
	WhyingAnkiPluginApi,
} from "./types";

interface CardRewrite {
	startOffset: number;
	endOffset: number;
	replacement: string;
}

interface PreparedCardState {
	originalCard: ParsedCard;
	finalCard: ParsedCard;
	previousSyncedRev: string | null;
}

interface PreparedScannedFile {
	scannedFile: ScannedFile;
	cards: PreparedCardState[];
	deletedUids: string[];
}

export async function validateMarkdownFile(
	plugin: WhyingAnkiPluginApi,
	file: TFile,
): Promise<ScannedFile> {
	return scanMarkdownFile(plugin.app, file, plugin.settings);
}

export async function reconcileMissingFiles(
	plugin: WhyingAnkiPluginApi,
): Promise<{ missingFilePaths: string[]; removedUnsyncedCards: number }> {
	const snapshot = plugin.indexStore.getSnapshot();
	const currentPaths = new Set(plugin.app.vault.getMarkdownFiles().map((file) => file.path));
	const missingFilePaths = Object.keys(snapshot.uidsByFile).filter(
		(filePath) => !currentPaths.has(filePath),
	);
	let removedUnsyncedCards = 0;

	for (const filePath of missingFilePaths) {
		const uids = snapshot.uidsByFile[filePath] ?? [];
		const syncedNoteIds = uids
			.map((uid) => snapshot.cardsByUid[uid]?.ankiNoteId)
			.filter((noteId): noteId is string => Boolean(noteId));
		const unsyncedUids = uids.filter((uid) => !snapshot.cardsByUid[uid]?.ankiNoteId);

		plugin.indexStore.queuePendingDelete(syncedNoteIds);
		plugin.indexStore.removeCardsByUids(unsyncedUids);
		removedUnsyncedCards += unsyncedUids.length;
	}

	plugin.indexStore.setLastFullReconcileAt(Date.now());

	if (missingFilePaths.length > 0 || removedUnsyncedCards > 0) {
		await plugin.savePluginData();
	}

	return { missingFilePaths, removedUnsyncedCards };
}

export async function refreshLocalMetadataForFiles(
	plugin: Plugin & WhyingAnkiPluginApi,
	files: TFile[],
): Promise<LocalRefreshResult> {
	const scannedFiles = await scanMarkdownFiles(plugin.app, files, plugin.settings);
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const result = createLocalResult();

	for (const scannedFile of scannedFiles) {
		result.filesProcessed += 1;
		result.cardsProcessed += scannedFile.cards.length;
		result.parseErrors.push(...scannedFile.errors);

		const prepared = await prepareScannedFile(scannedFile, indexSnapshot);
		const rewrites = buildCardRewrites(prepared.cards);
		const rewritten = await commitFileRewrites(
			plugin,
			scannedFile,
			rewrites,
			result.runtimeErrors,
		);
		if (!rewritten && rewrites.length > 0) {
			continue;
		}

		if (rewritten) {
			result.filesRewritten += 1;
		}

		plugin.indexStore.setFileCards(
			scannedFile.file.path,
			prepared.cards.map((card) => card.finalCard),
			{
				preserveUnseen: true,
				preserveSyncedRev: true,
			},
		);
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
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const rebuiltIndex = createEmptyPluginIndex();
	const rebuiltStore = new IndexStore(rebuiltIndex);
	const result = createLocalResult();

	rebuiltIndex.pendingDeleteNoteIds = plugin.indexStore.getPendingDeleteNoteIds();
	rebuiltIndex.lastFullReconcileAt = Date.now();

	for (const scannedFile of scannedFiles) {
		result.filesProcessed += 1;
		result.cardsProcessed += scannedFile.cards.length;
		result.parseErrors.push(...scannedFile.errors);

		const prepared = await prepareScannedFile(scannedFile, indexSnapshot);
		const rewrites = buildCardRewrites(prepared.cards);
		const rewritten = await commitFileRewrites(
			plugin,
			scannedFile,
			rewrites,
			result.runtimeErrors,
		);
		if (!rewritten && rewrites.length > 0) {
			continue;
		}

		if (rewritten) {
			result.filesRewritten += 1;
		}

		rebuiltStore.setFileCards(
			scannedFile.file.path,
			prepared.cards.map((card) => card.finalCard),
			{ preserveSyncedRev: true },
		);
	}

	plugin.indexStore.replace({
		...rebuiltStore.getSnapshot(),
		pendingDeleteNoteIds: rebuiltIndex.pendingDeleteNoteIds,
		lastFullReconcileAt: rebuiltIndex.lastFullReconcileAt,
	});
	await plugin.savePluginData();
	return result;
}

export async function syncCardsToAnki(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<SyncToAnkiResult> {
	await reconcileMissingFiles(plugin);

	const files = plugin.app.vault.getMarkdownFiles();
	const scannedFiles = await scanMarkdownFiles(plugin.app, files, plugin.settings);
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const result = createSyncResult();
	const client = new AnkiClient(plugin.settings);

	try {
		await client.ensureReadyForBasicSync();
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		return result;
	}

	const preparedFiles = await Promise.all(
		scannedFiles.map((scannedFile) => prepareScannedFile(scannedFile, indexSnapshot)),
	);

	const deleteNoteIds = new Set<string>();
	const orphanDeletedUids = new Set<string>();

	for (const preparedFile of preparedFiles) {
		const deletedRecords = preparedFile.deletedUids
			.map((uid) => indexSnapshot.cardsByUid[uid])
			.filter((record): record is NonNullable<typeof record> => record !== undefined);

		for (const record of deletedRecords) {
			if (record.ankiNoteId) {
				deleteNoteIds.add(record.ankiNoteId);
			} else {
				orphanDeletedUids.add(record.uid);
			}
		}
	}

	if (orphanDeletedUids.size > 0) {
		plugin.indexStore.removeCardsByUids([...orphanDeletedUids]);
	}

	plugin.indexStore.queuePendingDelete([...deleteNoteIds]);
	const pendingDeleteIds = plugin.indexStore.getPendingDeleteNoteIds();
	let deletePhaseSucceeded = pendingDeleteIds.length === 0;

	if (pendingDeleteIds.length > 0) {
		try {
			await client.deleteNotes(pendingDeleteIds);
			plugin.indexStore.removeCardsByNoteIds(pendingDeleteIds);
			result.cardsDeleted += pendingDeleteIds.length;
			deletePhaseSucceeded = true;
		} catch (error) {
			result.runtimeErrors.push(asErrorMessage(error));
		}
	}

	for (const preparedFile of preparedFiles) {
		const { scannedFile } = preparedFile;
		result.filesProcessed += 1;
		result.cardsProcessed += scannedFile.cards.length;
		result.parseErrors.push(...scannedFile.errors);

		const syncedStates: PreparedCardState[] = [];
		for (const state of preparedFile.cards) {
			syncedStates.push(await syncPreparedCard(client, state, result));
		}

		const rewrites = buildCardRewrites(syncedStates);
		const rewritten = await commitFileRewrites(
			plugin,
			scannedFile,
			rewrites,
			result.runtimeErrors,
		);

		if (rewritten) {
			result.filesRewritten += 1;
		}

		plugin.indexStore.setFileCards(
			scannedFile.file.path,
			syncedStates.map((state) => state.finalCard),
			{ preserveUnseen: !deletePhaseSucceeded },
		);

		if (rewritten || rewrites.length === 0) {
			plugin.indexStore.clearDirtyFile(scannedFile.file.path);
		}
	}

	await plugin.savePluginData();
	return result;
}

function createLocalResult(): LocalRefreshResult {
	return {
		filesProcessed: 0,
		filesRewritten: 0,
		cardsProcessed: 0,
		parseErrors: [],
		runtimeErrors: [],
	};
}

function createSyncResult(): SyncToAnkiResult {
	return {
		...createLocalResult(),
		cardsDeleted: 0,
		cardsCreated: 0,
		cardsUpdated: 0,
		cardsUnchanged: 0,
	};
}

async function prepareScannedFile(
	scannedFile: ScannedFile,
	indexSnapshot: PluginIndex,
): Promise<PreparedScannedFile> {
	const cards = await Promise.all(
		scannedFile.cards.map(async (originalCard) => {
			const existingRecord = findCardIndexRecord(indexSnapshot, originalCard.uid);
			const resolvedNoteId = originalCard.noteId ?? existingRecord?.ankiNoteId ?? null;
			const uid = originalCard.uid ?? generateCardUid();
			const rev = await computeCardRevision({
				effectiveDeck: originalCard.effectiveDeck,
				effectiveTags: originalCard.effectiveTags,
				frontNormalized: originalCard.frontNormalized,
				backNormalized: originalCard.backNormalized,
			});

			return {
				originalCard,
				finalCard: {
					...originalCard,
					uid,
					noteId: resolvedNoteId,
					rev,
				},
				previousSyncedRev:
					existingRecord?.lastSyncedRev ?? (resolvedNoteId ? originalCard.rev : null),
			};
		}),
	);

	const oldUids = new Set(indexSnapshot.uidsByFile[scannedFile.file.path] ?? []);
	const newUids = new Set(
		cards
			.map((card) => card.finalCard.uid)
			.filter((uid): uid is string => typeof uid === "string"),
	);

	return {
		scannedFile,
		cards,
		deletedUids: [...oldUids].filter((uid) => !newUids.has(normalizeCardUid(uid) ?? uid)),
	};
}

function findCardIndexRecord(
	indexSnapshot: PluginIndex,
	uid: string | null,
): CardIndexRecord | undefined {
	if (!uid) {
		return undefined;
	}

	const candidates = [uid];
	if (!uid.startsWith("c_")) {
		candidates.push(`c_${uid}`);
	}

	for (const candidate of candidates) {
		const record = indexSnapshot.cardsByUid[candidate];
		if (record) {
			return record;
		}
	}

	return undefined;
}

async function syncPreparedCard(
	client: AnkiClient,
	state: PreparedCardState,
	result: SyncToAnkiResult,
): Promise<PreparedCardState> {
	const card = state.finalCard;

	if (!card.effectiveDeck) {
		result.runtimeErrors.push(formatCardError(card, "Card deck is empty."));
		return {
			...state,
			finalCard: {
				...card,
				rev: state.previousSyncedRev,
			},
		};
	}

	if (!card.noteId) {
		try {
			const noteId = await client.addBasicNote({
				deckName: card.effectiveDeck,
				front: card.frontNormalized,
				back: card.backNormalized,
				tags: card.effectiveTags,
			});

			result.cardsCreated += 1;
			return {
				...state,
				finalCard: {
					...card,
					noteId,
				},
			};
		} catch (error) {
			result.runtimeErrors.push(formatCardError(card, asErrorMessage(error)));
			return {
				...state,
				finalCard: {
					...card,
					noteId: null,
					rev: null,
				},
			};
		}
	}

	if (state.previousSyncedRev === card.rev) {
		result.cardsUnchanged += 1;
		return state;
	}

	try {
		await client.updateBasicNote(card.noteId, {
			front: card.frontNormalized,
			back: card.backNormalized,
		});
		result.cardsUpdated += 1;
		return state;
	} catch (error) {
		result.runtimeErrors.push(formatCardError(card, asErrorMessage(error)));
		return {
			...state,
			finalCard: {
				...card,
				rev: state.previousSyncedRev,
			},
		};
	}
}

function buildCardRewrites(cards: PreparedCardState[]): CardRewrite[] {
	return cards
		.map((card) => {
			const replacement = serializeCardEnd({
				uid: card.finalCard.uid,
				noteId: card.finalCard.noteId,
				rev: card.finalCard.rev,
			});

			return replacement === card.originalCard.originalEndMarker
				? null
				: {
						startOffset: card.originalCard.endMarkerStartOffset,
						endOffset: card.originalCard.endMarkerEndOffset,
						replacement,
				  };
		})
		.filter((rewrite): rewrite is CardRewrite => rewrite !== null);
}

async function commitFileRewrites(
	plugin: WhyingAnkiPluginApi,
	scannedFile: ScannedFile,
	rewrites: CardRewrite[],
	runtimeErrors: string[],
): Promise<boolean> {
	if (rewrites.length === 0) {
		return false;
	}

	try {
		await plugin.app.vault.process(scannedFile.file, (current) => {
			if (current !== scannedFile.text) {
				throw new Error(`File changed during rewrite: ${scannedFile.file.path}`);
			}

			let rewritten = current;
			for (const rewrite of [...rewrites].sort(
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

function formatCardError(card: ParsedCard, message: string): string {
	return `${card.filePath}:${card.startLine} ${message}`;
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
