import type { Plugin, TFile } from "obsidian";
import { AnkiClient, type AnkiNoteInfo } from "./anki-client";
import { createEmptyPluginIndex, IndexStore } from "./index-store";
import { computeCardRevision, generateCardUid, normalizeCardUid } from "./normalize";
import { scanMarkdownFile, scanMarkdownFiles } from "./scanner";
import type { WhyingAnkiSettings } from "./settings";
import { serializeCardEnd } from "./syntax";
import type {
	CardIndexRecord,
	FileIndexRecord,
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

interface PreparedSyncFile extends PreparedScannedFile {
	fileRewritten: boolean;
}

interface IncrementalSyncSelection {
	files: TFile[];
	scanConfigSignature: string;
	staleDirtyPaths: string[];
}

const SCAN_CONFIG_SIGNATURE_VERSION = 1;

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
	const trackedPaths = new Set([
		...Object.keys(snapshot.uidsByFile),
		...Object.keys(snapshot.filesByPath),
	]);
	const missingFilePaths = [...trackedPaths].filter(
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
		plugin.indexStore.removeFileState(filePath);
		plugin.clearFileDirty(filePath);
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
	const scanConfigSignature = buildScanConfigSignature(plugin.settings);
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const result = createLocalResult();
	const cleanFilePaths: string[] = [];

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
			plugin.markFileDirty(scannedFile.file.path);
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
		if (
			updateTrackedFileState(
				plugin,
				plugin.indexStore,
				scannedFile.file.path,
				scanConfigSignature,
				scannedFile.errors.length > 0,
			)
		) {
			cleanFilePaths.push(scannedFile.file.path);
		}
	}

	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	return result;
}

export async function rebuildSyncIndex(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<LocalRefreshResult> {
	const files = plugin.app.vault.getMarkdownFiles();
	const scannedFiles = await scanMarkdownFiles(plugin.app, files, plugin.settings);
	const scanConfigSignature = buildScanConfigSignature(plugin.settings);
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const rebuiltIndex = createEmptyPluginIndex();
	const rebuiltStore = new IndexStore(rebuiltIndex);
	const result = createLocalResult();
	const cleanFilePaths: string[] = [];

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
			plugin.markFileDirty(scannedFile.file.path);
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
		if (
			updateTrackedFileState(
				plugin,
				rebuiltStore,
				scannedFile.file.path,
				scanConfigSignature,
				scannedFile.errors.length > 0,
			)
		) {
			cleanFilePaths.push(scannedFile.file.path);
		}
	}

	plugin.indexStore.replace({
		...rebuiltStore.getSnapshot(),
		pendingDeleteNoteIds: rebuiltIndex.pendingDeleteNoteIds,
		lastFullReconcileAt: rebuiltIndex.lastFullReconcileAt,
	});
	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	return result;
}

export async function syncCardsToAnki(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<SyncToAnkiResult> {
	await reconcileMissingFiles(plugin);
	return syncCardsToAnkiForFiles(
		plugin,
		plugin.app.vault.getMarkdownFiles(),
		buildScanConfigSignature(plugin.settings),
	);
}

export async function syncChangedCardsToAnki(
	plugin: Plugin & WhyingAnkiPluginApi,
): Promise<SyncToAnkiResult> {
	await reconcileMissingFiles(plugin);

	const selection = selectFilesForIncrementalSync(
		plugin,
		plugin.indexStore.getSnapshot(),
	);
	plugin.clearFilesDirty(selection.staleDirtyPaths);

	if (
		selection.files.length === 0 &&
		plugin.indexStore.getPendingDeleteNoteIds().length === 0
	) {
		return createSyncResult();
	}

	return syncCardsToAnkiForFiles(
		plugin,
		selection.files,
		selection.scanConfigSignature,
	);
}

async function syncCardsToAnkiForFiles(
	plugin: Plugin & WhyingAnkiPluginApi,
	files: TFile[],
	scanConfigSignature: string,
): Promise<SyncToAnkiResult> {
	const scannedFiles = await scanMarkdownFiles(plugin.app, files, plugin.settings);
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const result = createSyncResult();
	const client = new AnkiClient(plugin.settings);
	const cleanFilePaths: string[] = [];

	try {
		await client.ensureReadyForBasicSync();
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		return result;
	}

	const preparedFiles = await prepareSyncFiles(
		plugin,
		scannedFiles,
		indexSnapshot,
		result.runtimeErrors,
	);
	const activeNoteIds = collectActiveNoteIds(preparedFiles);
	plugin.indexStore.dequeuePendingDelete(activeNoteIds);

	let existingNotesById = new Map<string, AnkiNoteInfo>();
	try {
		existingNotesById = await client.getNotesInfo(activeNoteIds);
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		await plugin.savePluginData();
		return result;
	}

	try {
		await client.ensureDecksExist(collectDecksForNewCards(preparedFiles));
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
	}

	const deleteNoteIds = new Set<string>();
	const orphanDeletedUids = new Set<string>();

	for (const preparedFile of preparedFiles) {
		if (preparedFile.scannedFile.errors.length > 0) {
			continue;
		}

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
			syncedStates.push(
				await syncPreparedCard(
					client,
					state,
					state.finalCard.noteId
						? existingNotesById.get(state.finalCard.noteId) ?? null
						: null,
					result,
				),
			);
		}

		const rewrites = buildCardRewrites(syncedStates);
		const rewritten = await commitFileRewrites(
			plugin,
			scannedFile,
			rewrites,
			result.runtimeErrors,
		);
		const rewriteRequired = rewrites.length > 0;

		if (preparedFile.fileRewritten || rewritten) {
			result.filesRewritten += 1;
		}

		plugin.indexStore.setFileCards(
			scannedFile.file.path,
			syncedStates.map((state) => state.finalCard),
			{
				preserveUnseen:
					!deletePhaseSucceeded || scannedFile.errors.length > 0,
			},
		);

		if (!rewriteRequired || rewritten) {
			if (
				updateTrackedFileState(
					plugin,
					plugin.indexStore,
					scannedFile.file.path,
					scanConfigSignature,
					scannedFile.errors.length > 0,
				)
			) {
				cleanFilePaths.push(scannedFile.file.path);
			}
		} else {
			plugin.markFileDirty(scannedFile.file.path);
		}
	}

	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
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

async function prepareSyncFiles(
	plugin: Plugin & WhyingAnkiPluginApi,
	scannedFiles: ScannedFile[],
	indexSnapshot: PluginIndex,
	runtimeErrors: string[],
): Promise<PreparedSyncFile[]> {
	const preparedFiles: PreparedSyncFile[] = [];

	for (const scannedFile of scannedFiles) {
		const preparedFile = await prepareScannedFile(scannedFile, indexSnapshot);
		const stabilizedFile = await ensureFileHasStableUids(
			plugin,
			preparedFile,
			indexSnapshot,
			runtimeErrors,
		);
		if (stabilizedFile) {
			preparedFiles.push(stabilizedFile);
		}
	}

	return preparedFiles;
}

async function ensureFileHasStableUids(
	plugin: WhyingAnkiPluginApi,
	preparedFile: PreparedScannedFile,
	indexSnapshot: PluginIndex,
	runtimeErrors: string[],
): Promise<PreparedSyncFile | null> {
	const uidRewrites = buildUidRewrites(preparedFile.cards);
	if (uidRewrites.length === 0) {
		return { ...preparedFile, fileRewritten: false };
	}

	const rewritten = await commitFileRewrites(
		plugin,
		preparedFile.scannedFile,
		uidRewrites,
		runtimeErrors,
	);
	if (!rewritten) {
		plugin.markFileDirty(preparedFile.scannedFile.file.path);
		return null;
	}

	const rescannedFile = await scanMarkdownFile(
		plugin.app,
		preparedFile.scannedFile.file,
		plugin.settings,
	);
	const rescannedPreparedFile = await prepareScannedFile(rescannedFile, indexSnapshot);

	return {
		...rescannedPreparedFile,
		fileRewritten: true,
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

function collectDecksForNewCards(preparedFiles: PreparedScannedFile[]): string[] {
	return preparedFiles.flatMap((preparedFile) =>
		preparedFile.cards
			.map((state) => state.finalCard.effectiveDeck)
			.filter(Boolean),
	);
}

async function syncPreparedCard(
	client: AnkiClient,
	state: PreparedCardState,
	existingNote: AnkiNoteInfo | null,
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

	if (!card.noteId || existingNote === null) {
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
			tags: card.effectiveTags,
		});
		await client.changeDeck(existingNote.cards, card.effectiveDeck);
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

function buildUidRewrites(cards: PreparedCardState[]): CardRewrite[] {
	return cards
		.map((card) => {
			if (card.originalCard.uid) {
				return null;
			}

			return {
				startOffset: card.originalCard.endMarkerStartOffset,
				endOffset: card.originalCard.endMarkerEndOffset,
				replacement: serializeCardEnd({
					uid: card.finalCard.uid,
					noteId: card.originalCard.noteId,
					rev: card.originalCard.rev,
				}),
			};
		})
		.filter((rewrite): rewrite is CardRewrite => rewrite !== null);
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

function collectActiveNoteIds(preparedFiles: PreparedSyncFile[]): string[] {
	return [
		...new Set(
			preparedFiles.flatMap((preparedFile) =>
				preparedFile.cards
					.map((state) => state.finalCard.noteId)
					.filter((noteId): noteId is string => Boolean(noteId)),
			),
		),
	];
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

			plugin.registerInternalFileWrite(scannedFile.file.path);
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

function buildScanConfigSignature(settings: WhyingAnkiSettings): string {
	return JSON.stringify({
		version: SCAN_CONFIG_SIGNATURE_VERSION,
		defaultDeck: settings.defaultDeck.trim(),
		defaultTags: [...settings.defaultTags]
			.map((tag) => tag.trim())
			.filter(Boolean)
			.sort((left, right) => left.localeCompare(right)),
		appendObsidianUriToBack: settings.appendObsidianUriToBack,
	});
}

function selectFilesForIncrementalSync(
	plugin: WhyingAnkiPluginApi,
	indexSnapshot: PluginIndex,
): IncrementalSyncSelection {
	const scanConfigSignature = buildScanConfigSignature(plugin.settings);
	const dirtyPaths = new Set(plugin.getDirtyFilePaths());
	const filesByPath = new Map(
		plugin.app.vault.getMarkdownFiles().map((file) => [file.path, file]),
	);
	const staleDirtyPaths = [...dirtyPaths].filter((filePath) => !filesByPath.has(filePath));
	const files = [...filesByPath.values()].filter((file) =>
		shouldIncrementallySyncFile(
			file,
			indexSnapshot.filesByPath[file.path],
			dirtyPaths,
			scanConfigSignature,
		),
	);

	return {
		files,
		scanConfigSignature,
		staleDirtyPaths,
	};
}

function shouldIncrementallySyncFile(
	file: TFile,
	fileRecord: FileIndexRecord | undefined,
	dirtyPaths: ReadonlySet<string>,
	scanConfigSignature: string,
): boolean {
	if (dirtyPaths.has(file.path)) {
		return true;
	}

	if (!fileRecord) {
		return true;
	}

	return (
		fileRecord.lastIndexedMtime !== file.stat.mtime ||
		fileRecord.lastIndexedSize !== file.stat.size ||
		fileRecord.lastScanConfigHash !== scanConfigSignature
	);
}

function updateTrackedFileState(
	plugin: WhyingAnkiPluginApi,
	indexStore: WhyingAnkiPluginApi["indexStore"],
	filePath: string,
	scanConfigSignature: string,
	hasParseErrors: boolean,
): boolean {
	const file = plugin.app.vault.getFileByPath(filePath);
	if (!file) {
		return false;
	}

	indexStore.setFileState(filePath, {
		lastIndexedMtime: file.stat.mtime,
		lastIndexedSize: file.stat.size,
		lastScanConfigHash: scanConfigSignature,
		lastIndexedAt: Date.now(),
		hasParseErrors,
	});
	return true;
}
