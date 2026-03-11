import type { Plugin, TFile } from "obsidian";
import { AnkiClient, type AnkiNoteInfo } from "./anki-client";
import {
	OBAK_MODEL_NAME,
	type ObakNoteInput,
} from "./anki-model";
import { createEmptyPluginIndex, IndexStore } from "./index-store";
import { logVerbose } from "./logger";
import { computeCardRevision, generateCardUid } from "./normalize";
import { scanMarkdownFile, scanMarkdownFiles } from "./scanner";
import type { ObakSettings } from "./settings";
import { serializeCardEnd } from "./syntax";
import type {
	CardIndexRecord,
	LocalRefreshResult,
	ParsedCard,
	PluginIndex,
	ScannedFile,
	SyncToAnkiResult,
	ObakPluginApi,
	SyncExecutionOptions,
	SyncProgressUpdate,
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

interface MissingFileReconcileResult {
	missingFilePaths: string[];
	removedUnsyncedCards: number;
	deferred: boolean;
}

interface DeletedFileProcessingResult {
	changed: boolean;
	filePaths: string[];
	removedUnsyncedCards: number;
}

interface PendingCreateCandidate {
	existingNote: AnkiNoteInfo | null;
	state: PreparedCardState;
}

interface UidRecoveryResult {
	blockedCardKeys: Set<string>;
	recoveredNoteIds: string[];
}

interface UidConflictFilterResult {
	conflictMessages: string[];
	safeScannedFiles: ScannedFile[];
}

const SCAN_CONFIG_SIGNATURE_VERSION = 2;

export async function validateMarkdownFile(
	plugin: ObakPluginApi,
	file: TFile,
): Promise<ScannedFile> {
	return scanMarkdownFile(plugin.app, file, plugin.settings);
}

export async function reconcileMissingFiles(
	plugin: ObakPluginApi,
): Promise<MissingFileReconcileResult> {
	const snapshot = plugin.indexStore.getSnapshot();
	const currentPaths = new Set(plugin.app.vault.getMarkdownFiles().map((file) => file.path));
	const trackedPaths = Object.keys(snapshot.uidsByFile);
	const missingFilePaths = trackedPaths.filter(
		(filePath) => !currentPaths.has(filePath),
	);
	let changed = false;

	logVerbose(plugin, "Reconciling missing files.", {
		trackedFiles: trackedPaths.length,
		currentFiles: currentPaths.size,
		missingTrackedFiles: missingFilePaths.length,
	});

	if (trackedPaths.length > 0 && currentPaths.size === 0) {
		logVerbose(
			plugin,
			"Deferred reconcile because tracked files exist but the vault markdown file list is still empty.",
			{
				trackedFiles: trackedPaths.length,
				currentFiles: currentPaths.size,
			},
		);
		return {
			missingFilePaths: [],
			removedUnsyncedCards: 0,
			deferred: true,
		};
	}

	for (const filePath of missingFilePaths) {
		changed = plugin.indexStore.markFileDeleted(filePath) || changed;
	}

	const deletedResult = processDeletedFiles(plugin, currentPaths);
	plugin.indexStore.setLastFullReconcileAt(Date.now());

	if (
		changed ||
		deletedResult.changed ||
		deletedResult.filePaths.length > 0 ||
		deletedResult.removedUnsyncedCards > 0
	) {
		await plugin.savePluginData();
	}

	const result = {
		missingFilePaths: deletedResult.filePaths,
		removedUnsyncedCards: deletedResult.removedUnsyncedCards,
		deferred: false,
	};
	logVerbose(plugin, "Finished reconciling missing files.", result);
	return result;
}

export async function refreshLocalMetadataForFiles(
	plugin: Plugin & ObakPluginApi,
	files: TFile[],
): Promise<LocalRefreshResult> {
	logVerbose(plugin, "Refreshing local metadata.", {
		fileCount: files.length,
		filePaths: files.map((file) => file.path),
	});
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const scannedFiles = filterScannedFilesWithUidConflicts(
		plugin,
		await scanMarkdownFiles(plugin.app, files, plugin.settings),
		indexSnapshot,
	);
	const result = createLocalResult();
	const cleanFilePaths: string[] = [];
	logVerbose(plugin, "Scanned files for local metadata refresh.", {
		safeFiles: scannedFiles.safeScannedFiles.length,
		conflicts: scannedFiles.conflictMessages.length,
	});

	result.runtimeErrors.push(...scannedFiles.conflictMessages);

	for (const scannedFile of scannedFiles.safeScannedFiles) {
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
		logVerbose(plugin, `Prepared refreshed metadata for ${scannedFile.file.path}.`, {
			cards: prepared.cards.length,
			rewritten,
			parseErrors: scannedFile.errors.length,
		});

		plugin.indexStore.setFileCards(
			scannedFile.file.path,
			prepared.cards.map((card) => card.finalCard),
			{
				preserveUnseen: true,
				preserveSyncedRev: true,
			},
		);
		cleanFilePaths.push(scannedFile.file.path);
	}

	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	logVerbose(plugin, "Finished refreshing local metadata.", result);
	return result;
}

export async function rebuildSyncIndex(
	plugin: Plugin & ObakPluginApi,
): Promise<LocalRefreshResult> {
	const files = plugin.app.vault.getMarkdownFiles();
	const scanConfigSignature = buildScanConfigSignature(plugin.settings);
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const scannedFiles = filterScannedFilesWithUidConflicts(
		plugin,
		await scanMarkdownFiles(plugin.app, files, plugin.settings),
		indexSnapshot,
	);
	const rebuiltIndex = createEmptyPluginIndex();
	const rebuiltStore = new IndexStore(rebuiltIndex);
	const result = createLocalResult();
	const cleanFilePaths: string[] = [];

	logVerbose(plugin, "Rebuilding sync index from vault files.", {
		fileCount: files.length,
	});

	if (scannedFiles.conflictMessages.length > 0) {
		result.runtimeErrors.push(...scannedFiles.conflictMessages);
		result.runtimeErrors.push(
			"Rebuild aborted because duplicate card UID conflicts must be resolved first.",
		);
		logVerbose(plugin, "Rebuild aborted due to duplicate UID conflicts.", {
			conflicts: scannedFiles.conflictMessages.length,
		});
		return result;
	}

	rebuiltIndex.pendingDeleteNoteIds = plugin.indexStore.getPendingDeleteNoteIds();
	rebuiltIndex.lastFullReconcileAt = Date.now();

	for (const scannedFile of scannedFiles.safeScannedFiles) {
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
		logVerbose(plugin, `Rebuilt index entry for ${scannedFile.file.path}.`, {
			cards: prepared.cards.length,
			rewritten,
			parseErrors: scannedFile.errors.length,
		});

		rebuiltStore.setFileCards(
			scannedFile.file.path,
			prepared.cards.map((card) => card.finalCard),
			{ preserveSyncedRev: true },
		);
		cleanFilePaths.push(scannedFile.file.path);
	}

	rebuiltStore.setLastSyncAt(Date.now());
	rebuiltStore.setLastScanConfigHash(scanConfigSignature);

	plugin.indexStore.replace({
		...rebuiltStore.getSnapshot(),
		pendingDeleteNoteIds: rebuiltIndex.pendingDeleteNoteIds,
		lastFullReconcileAt: rebuiltIndex.lastFullReconcileAt,
	});
	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	logVerbose(plugin, "Finished rebuilding sync index.", result);
	return result;
}

export async function syncCardsToAnki(
	plugin: Plugin & ObakPluginApi,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	logVerbose(plugin, "Running full sync workflow.");
	reportSyncProgress(options, {
		message: "Reconciling vault changes...",
		completed: 0,
		total: null,
	});
	const reconcileResult = await reconcileMissingFiles(plugin);
	if (reconcileResult.deferred) {
		const result = createSyncResult();
		result.runtimeErrors.push(
			"Vault markdown files are still loading. Sync was skipped to avoid false deletions; wait for Obsidian to finish loading and try again.",
		);
		logVerbose(
			plugin,
			"Skipped full sync because reconcile was deferred while vault files are still loading.",
		);
		return result;
	}

	return syncCardsToAnkiForFiles(
		plugin,
		plugin.app.vault.getMarkdownFiles(),
		buildScanConfigSignature(plugin.settings),
		true,
		options,
	);
}

export async function syncChangedCardsToAnki(
	plugin: Plugin & ObakPluginApi,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	logVerbose(plugin, "Running incremental sync workflow.");
	reportSyncProgress(options, {
		message: "Reconciling vault changes...",
		completed: 0,
		total: null,
	});
	const reconcileResult = await reconcileMissingFiles(plugin);
	if (reconcileResult.deferred) {
		const result = createSyncResult();
		result.runtimeErrors.push(
			"Vault markdown files are still loading. Sync was skipped to avoid false deletions; wait for Obsidian to finish loading and try again.",
		);
		logVerbose(
			plugin,
			"Skipped incremental sync because reconcile was deferred while vault files are still loading.",
		);
		return result;
	}

	const selection = selectFilesForIncrementalSync(
		plugin,
		plugin.indexStore.getSnapshot(),
	);
	logVerbose(plugin, "Selected files for incremental sync.", {
		fileCount: selection.files.length,
		filePaths: selection.files.map((file) => file.path),
		staleDirtyPaths: selection.staleDirtyPaths,
		scanConfigSignature: selection.scanConfigSignature,
	});
	plugin.clearFilesDirty(selection.staleDirtyPaths);

	if (
		selection.files.length === 0 &&
		plugin.indexStore.getPendingDeleteNoteIds().length === 0
	) {
		logVerbose(plugin, "Incremental sync found no pending work.");
		plugin.indexStore.setLastSyncAt(Date.now());
		plugin.indexStore.setLastScanConfigHash(selection.scanConfigSignature);
		await plugin.savePluginData();
		return createSyncResult();
	}

	return syncCardsToAnkiForFiles(
		plugin,
		selection.files,
		selection.scanConfigSignature,
		true,
		options,
	);
}

async function syncCardsToAnkiForFiles(
	plugin: Plugin & ObakPluginApi,
	files: TFile[],
	scanConfigSignature: string,
	advanceSyncCursor = false,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	logVerbose(plugin, "Starting sync for selected files.", {
		fileCount: files.length,
		filePaths: files.map((file) => file.path),
		advanceSyncCursor,
	});
	reportSyncProgress(options, {
		message: "Scanning markdown files...",
		completed: 0,
		total: null,
	});
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const scannedFiles = filterScannedFilesWithUidConflicts(
		plugin,
		await scanMarkdownFiles(plugin.app, files, plugin.settings),
		indexSnapshot,
	);
	const result = createSyncResult();
	const client = new AnkiClient(plugin.settings);
	const cleanFilePaths: string[] = [];
	const totalCardsToSync = scannedFiles.safeScannedFiles.reduce(
		(count, scannedFile) => count + scannedFile.cards.length,
		0,
	);
	const totalProgressSteps = 5 + totalCardsToSync;
	let completedProgressSteps = 1;

	logVerbose(plugin, "Completed markdown scan for sync.", {
		safeFiles: scannedFiles.safeScannedFiles.length,
		conflicts: scannedFiles.conflictMessages.length,
		totalCardsToSync,
	});

	for (const message of scannedFiles.conflictMessages) {
		result.runtimeErrors.push(message);
	}

	reportSyncProgress(options, {
		message: `Scanned ${scannedFiles.safeScannedFiles.length} file(s) for sync.`,
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

	try {
		await client.ensureReadyForSync();
		logVerbose(plugin, "Anki client is ready for sync.");
		completedProgressSteps += 1;
		reportSyncProgress(options, {
			message: "Connected to Anki and verified the Obak model.",
			completed: completedProgressSteps,
			total: totalProgressSteps,
		});
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		logVerbose(plugin, "Failed while preparing Anki client.", error);
		return result;
	}

	const preparedFiles = await prepareSyncFiles(
		plugin,
		scannedFiles.safeScannedFiles,
		indexSnapshot,
		result.runtimeErrors,
	);
	const activeNoteIds = collectActiveNoteIds(preparedFiles);

	let existingNotesById = new Map<string, AnkiNoteInfo>();
	try {
		existingNotesById = await client.getNotesInfo(activeNoteIds);
		logVerbose(plugin, "Loaded existing Anki notes for active cards.", {
			activeNoteIds: activeNoteIds.length,
			loadedNotes: existingNotesById.size,
		});
		completedProgressSteps += 1;
		reportSyncProgress(options, {
			message: "Loaded existing note information from Anki.",
			completed: completedProgressSteps,
			total: totalProgressSteps,
		});
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		logVerbose(plugin, "Failed while loading existing Anki note info.", error);
		await plugin.savePluginData();
		return result;
	}

	reportSyncProgress(options, {
		message: "Preparing deck, UID, and duplicate checks...",
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

	try {
		await client.ensureDecksExist(collectDecksForNewCards(preparedFiles));
		logVerbose(plugin, "Ensured target decks exist for new cards.");
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		logVerbose(plugin, "Failed while ensuring target decks exist.", error);
	}

	const uidRecoveryResult = await recoverPreparedCardsByUid(
		client,
		preparedFiles,
		existingNotesById,
		result.runtimeErrors,
	);

	if (uidRecoveryResult.recoveredNoteIds.length > 0) {
		logVerbose(plugin, "Recovered Anki note IDs by Obsidian UID.", {
			recovered: uidRecoveryResult.recoveredNoteIds.length,
		});
		try {
			const recoveredNotes = await client.getNotesInfo(uidRecoveryResult.recoveredNoteIds);
			existingNotesById = new Map([...existingNotesById, ...recoveredNotes]);
		} catch (error) {
			result.runtimeErrors.push(asErrorMessage(error));
			logVerbose(plugin, "Failed while loading recovered note details.", error);
		}
	}

	plugin.indexStore.dequeuePendingDelete(collectActiveNoteIds(preparedFiles));

	const blockedCreateCardKeys = await buildBlockedCreateCardKeys(
		client,
		preparedFiles,
		existingNotesById,
		result.runtimeErrors,
		uidRecoveryResult.blockedCardKeys,
	);
	logVerbose(plugin, "Finished pre-sync validation checks.", {
		blockedCreateCards: blockedCreateCardKeys.size,
		uidRecoveryBlocks: uidRecoveryResult.blockedCardKeys.size,
	});
	completedProgressSteps += 1;
	reportSyncProgress(options, {
		message: "Finished pre-sync validation checks.",
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

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
	logVerbose(plugin, "Prepared note deletions.", {
		deleteCandidates: deleteNoteIds.size,
		pendingDeletes: pendingDeleteIds.length,
		orphanDeletedUids: orphanDeletedUids.size,
	});

	if (pendingDeleteIds.length > 0) {
		reportSyncProgress(options, {
			message: `Deleting ${pendingDeleteIds.length} note(s) removed from the vault...`,
			completed: completedProgressSteps,
			total: totalProgressSteps,
		});
		try {
			await client.deleteNotes(pendingDeleteIds);
			plugin.indexStore.removeCardsByNoteIds(pendingDeleteIds);
			result.cardsDeleted += pendingDeleteIds.length;
			deletePhaseSucceeded = true;
			logVerbose(plugin, "Deleted notes removed from the vault.", {
				deletedNotes: pendingDeleteIds.length,
			});
		} catch (error) {
			result.runtimeErrors.push(asErrorMessage(error));
			logVerbose(plugin, "Failed while deleting notes in Anki.", error);
		}
	}

	completedProgressSteps += 1;
	reportSyncProgress(options, {
		message:
			pendingDeleteIds.length > 0
				? "Finished processing deleted notes."
				: "No deleted notes needed processing.",
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

	let processedCards = 0;
	for (const preparedFile of preparedFiles) {
		const { scannedFile } = preparedFile;
		result.filesProcessed += 1;
		result.cardsProcessed += scannedFile.cards.length;
		result.parseErrors.push(...scannedFile.errors);

		const syncedStates: PreparedCardState[] = [];
		for (const state of preparedFile.cards) {
			syncedStates.push(
				await syncPreparedCard(
					plugin,
					client,
					state,
					state.finalCard.noteId
						? existingNotesById.get(state.finalCard.noteId) ?? null
						: null,
					result,
					!blockedCreateCardKeys.has(getCardLocationKey(state.finalCard)),
				),
			);
			processedCards += 1;
			reportSyncProgress(options, {
				message: `Syncing card ${processedCards}/${totalCardsToSync}: ${getCardLocationKey(state.finalCard)}`,
				completed: completedProgressSteps + processedCards,
				total: totalProgressSteps,
			});
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
		logVerbose(plugin, `Finished syncing file ${scannedFile.file.path}.`, {
			cards: preparedFile.cards.length,
			parseErrors: scannedFile.errors.length,
			fileRewritten: preparedFile.fileRewritten,
			endMarkerRewritten: rewritten,
		});

		plugin.indexStore.setFileCards(
			scannedFile.file.path,
			syncedStates.map((state) => state.finalCard),
			{
				preserveUnseen:
					!deletePhaseSucceeded || scannedFile.errors.length > 0,
			},
		);

		if (!rewriteRequired || rewritten) {
			cleanFilePaths.push(scannedFile.file.path);
		} else {
			plugin.markFileDirty(scannedFile.file.path);
		}
	}

	if (advanceSyncCursor) {
		plugin.indexStore.setLastSyncAt(Date.now());
		plugin.indexStore.setLastScanConfigHash(scanConfigSignature);
	}

	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	logVerbose(plugin, "Finished sync workflow.", result);
	reportSyncProgress(options, {
		message: `Finished syncing ${result.cardsProcessed} card(s).`,
		completed: totalProgressSteps,
		total: totalProgressSteps,
	});
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
				obUri: originalCard.obUri,
				obsidianPath: originalCard.filePath,
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
		deletedUids: [...oldUids].filter((uid) => !newUids.has(uid)),
	};
}

async function prepareSyncFiles(
	plugin: Plugin & ObakPluginApi,
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
	plugin: ObakPluginApi,
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
	return uid ? indexSnapshot.cardsByUid[uid] : undefined;
}

function collectDecksForNewCards(preparedFiles: PreparedScannedFile[]): string[] {
	return preparedFiles.flatMap((preparedFile) =>
		preparedFile.cards
			.map((state) => state.finalCard.effectiveDeck)
			.filter(Boolean),
	);
}

async function syncPreparedCard(
	plugin: ObakPluginApi,
	client: AnkiClient,
	state: PreparedCardState,
	existingNote: AnkiNoteInfo | null,
	result: SyncToAnkiResult,
	allowCreate: boolean,
): Promise<PreparedCardState> {
	const card = state.finalCard;

	if (!card.effectiveDeck) {
		logVerbose(plugin, `Skipped card with empty deck: ${getCardLocationKey(card)}`);
		result.runtimeErrors.push(formatCardError(card, "Card deck is empty."));
		return {
			...state,
			finalCard: {
				...card,
				rev: state.previousSyncedRev,
			},
		};
	}

	if (!allowCreate) {
		logVerbose(
			plugin,
			`Blocked card creation after preflight checks: ${getCardLocationKey(card)}`,
		);
		return {
			...state,
			finalCard: {
				...card,
				noteId: null,
				rev: null,
			},
		};
	}

	if (existingNote && existingNote.modelName !== OBAK_MODEL_NAME) {
		logVerbose(plugin, `Skipped card with incompatible Anki model: ${getCardLocationKey(card)}`, {
			noteId: existingNote.noteId,
			modelName: existingNote.modelName,
		});
		result.runtimeErrors.push(
			formatCardError(
				card,
				`Anki note ${existingNote.noteId} uses model "${existingNote.modelName}", but sync now requires "${OBAK_MODEL_NAME}". Delete the old note and sync again.`,
			),
		);
		return {
			...state,
			finalCard: {
				...card,
				rev: state.previousSyncedRev,
			},
		};
	}

	if (!card.noteId || existingNote === null) {
		const createInput = buildObakNoteInput(card, null);
		try {
			const noteId = await client.addObakNote(createInput);
			result.cardsCreated += 1;
			logVerbose(plugin, `Created new Anki note for ${getCardLocationKey(card)}.`, {
				noteId,
			});

			try {
				await client.updateObakNote(noteId, buildObakNoteInput(card, noteId));
				logVerbose(
					plugin,
					`Finalized Anki note fields after creation for ${getCardLocationKey(card)}.`,
				);
			} catch (error) {
				result.runtimeErrors.push(
					formatCardError(
						card,
						`Created note ${noteId}, but failed to finalize AnkiNoteId field: ${asErrorMessage(
							error,
						)}`,
					),
				);
				return {
					...state,
					finalCard: {
						...card,
						noteId,
						rev: null,
					},
				};
			}

			return {
				...state,
				finalCard: {
					...card,
					noteId,
				},
			};
		} catch (error) {
			result.runtimeErrors.push(
				formatCardError(card, formatCreateNoteErrorMessage(error)),
			);
			logVerbose(plugin, `Failed to create Anki note for ${getCardLocationKey(card)}.`, error);
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
		logVerbose(plugin, `Card unchanged; skipped update for ${getCardLocationKey(card)}.`);
		return state;
	}

	try {
		await client.updateObakNote(
			card.noteId,
			buildObakNoteInput(card, card.noteId),
		);
		await client.changeDeck(existingNote.cards, card.effectiveDeck);
		result.cardsUpdated += 1;
		logVerbose(plugin, `Updated existing Anki note for ${getCardLocationKey(card)}.`, {
			noteId: card.noteId,
		});
		return state;
	} catch (error) {
		result.runtimeErrors.push(formatCardError(card, asErrorMessage(error)));
		logVerbose(plugin, `Failed to update Anki note for ${getCardLocationKey(card)}.`, error);
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
	plugin: ObakPluginApi,
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

		logVerbose(plugin, `Rewrote card metadata in ${scannedFile.file.path}.`, {
			rewriteCount: rewrites.length,
		});
		return true;
	} catch (error) {
		runtimeErrors.push(asErrorMessage(error));
		logVerbose(plugin, `Failed to rewrite card metadata in ${scannedFile.file.path}.`, error);
		return false;
	}
}

function formatCardError(card: ParsedCard, message: string): string {
	return `${card.filePath}:${card.startLine} ${message}`;
}

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reportSyncProgress(
	options: SyncExecutionOptions | undefined,
	update: SyncProgressUpdate,
): void {
	options?.onProgress?.(update);
}

function formatCreateNoteErrorMessage(error: unknown): string {
	const message = asErrorMessage(error);
	if (message.includes("cannot create note because it is a duplicate")) {
		return "Cannot create note because ObsidianUid already exists in Anki.";
	}

	return message;
}

function buildScanConfigSignature(settings: ObakSettings): string {
	return JSON.stringify({
		version: SCAN_CONFIG_SIGNATURE_VERSION,
		defaultDeck: settings.defaultDeck.trim(),
		defaultTags: [...settings.defaultTags]
			.map((tag) => tag.trim())
			.filter(Boolean)
			.sort((left, right) => left.localeCompare(right)),
	});
}

function processDeletedFiles(
	plugin: ObakPluginApi,
	currentPaths = new Set(plugin.app.vault.getMarkdownFiles().map((file) => file.path)),
): DeletedFileProcessingResult {
	const snapshot = plugin.indexStore.getSnapshot();
	let changed = false;
	const filePaths: string[] = [];
	let removedUnsyncedCards = 0;

	for (const filePath of snapshot.deletedFilePaths) {
		if (currentPaths.has(filePath)) {
			plugin.indexStore.clearDeletedFile(filePath);
			changed = true;
			continue;
		}

		const uids = snapshot.uidsByFile[filePath] ?? [];
		if (uids.length === 0) {
			plugin.indexStore.clearDeletedFile(filePath);
			changed = true;
			continue;
		}

		const syncedNoteIds = uids
			.map((uid) => snapshot.cardsByUid[uid]?.ankiNoteId)
			.filter((noteId): noteId is string => Boolean(noteId));
		const unsyncedUids = uids.filter((uid) => !snapshot.cardsByUid[uid]?.ankiNoteId);

		plugin.indexStore.queuePendingDelete(syncedNoteIds);
		plugin.indexStore.removeCardsByUids(unsyncedUids);
		plugin.indexStore.removeFileTracking(filePath);
		plugin.indexStore.clearDeletedFile(filePath);
		plugin.clearFileDirty(filePath);
		changed = true;
		filePaths.push(filePath);
		removedUnsyncedCards += unsyncedUids.length;
	}

	return { changed, filePaths, removedUnsyncedCards };
}

function filterScannedFilesWithUidConflicts(
	plugin: ObakPluginApi,
	scannedFiles: ScannedFile[],
	indexSnapshot: PluginIndex,
): UidConflictFilterResult {
	const claimsByUid = new Map<string, ParsedCard[]>();
	const scannedFilePaths = new Set(scannedFiles.map((scannedFile) => scannedFile.file.path));
	const conflictMessages: string[] = [];
	const conflictedFilePaths = new Set<string>();

	for (const scannedFile of scannedFiles) {
		for (const card of scannedFile.cards) {
			if (!card.uid) {
				continue;
			}

			const claims = claimsByUid.get(card.uid) ?? [];
			claims.push(card);
			claimsByUid.set(card.uid, claims);
		}
	}

	for (const [uid, claims] of claimsByUid.entries()) {
		if (claims.length > 1) {
			conflictMessages.push(
				`Duplicate card UID "${uid}" found at ${formatCardLocations(claims)}. Keep each card UID unique across the vault.`,
			);
			for (const claim of claims) {
				conflictedFilePaths.add(claim.filePath);
			}
			continue;
		}

		const claim = claims[0];
		if (!claim) {
			continue;
		}

		const existingRecord = findCardIndexRecord(indexSnapshot, uid);
		if (!existingRecord || existingRecord.filePath === claim.filePath) {
			continue;
		}

		if (!plugin.app.vault.getFileByPath(existingRecord.filePath)) {
			continue;
		}

		if (scannedFilePaths.has(existingRecord.filePath)) {
			continue;
		}

		conflictMessages.push(
			`Duplicate card UID "${uid}" at ${claim.filePath}:${claim.startLine} conflicts with ${existingRecord.filePath}. Remove the duplicate or move the original card first.`,
		);
		conflictedFilePaths.add(claim.filePath);
	}

	for (const filePath of conflictedFilePaths) {
		plugin.markFileDirty(filePath);
	}

	if (conflictMessages.length > 0) {
		logVerbose(plugin, "Detected duplicate UID conflicts during scan.", {
			conflicts: conflictMessages.length,
			conflictedFiles: [...conflictedFilePaths],
		});
	}

	return {
		conflictMessages,
		safeScannedFiles: scannedFiles.filter(
			(scannedFile) => !conflictedFilePaths.has(scannedFile.file.path),
		),
	};
}

async function buildBlockedCreateCardKeys(
	client: AnkiClient,
	preparedFiles: PreparedSyncFile[],
	existingNotesById: ReadonlyMap<string, AnkiNoteInfo>,
	runtimeErrors: string[],
	initialBlockedCardKeys: ReadonlySet<string> = new Set<string>(),
): Promise<Set<string>> {
	const blockedCardKeys = new Set<string>(initialBlockedCardKeys);
	const createCandidates = collectCreateCandidates(preparedFiles, existingNotesById);

	const remainingCandidates = createCandidates.filter(
		(candidate) => !blockedCardKeys.has(getCardLocationKey(candidate.state.finalCard)),
	);
	const preflightCandidates = remainingCandidates.filter((candidate) =>
		Boolean(candidate.state.finalCard.effectiveDeck.trim()),
	);
	if (preflightCandidates.length === 0) {
		return blockedCardKeys;
	}

	try {
		const canAddResults = await client.canAddObakNotes(
			preflightCandidates.map((candidate) =>
				buildObakNoteInput(candidate.state.finalCard, null),
			),
		);

		preflightCandidates.forEach((candidate, index) => {
			if (canAddResults[index]) {
				return;
			}

			blockedCardKeys.add(getCardLocationKey(candidate.state.finalCard));
			runtimeErrors.push(
				formatCardError(
					candidate.state.finalCard,
					"Cannot create note in Anki. Preflight check failed; this usually means ObsidianUid already exists.",
				),
			);
		});
	} catch (error) {
		runtimeErrors.push(`Anki preflight check failed: ${asErrorMessage(error)}`);
	}

	return blockedCardKeys;
}

function collectCreateCandidates(
	preparedFiles: PreparedSyncFile[],
	existingNotesById: ReadonlyMap<string, AnkiNoteInfo>,
): PendingCreateCandidate[] {
	return preparedFiles.flatMap((preparedFile) =>
		preparedFile.cards
			.map((state) => ({
				state,
				existingNote: state.finalCard.noteId
					? existingNotesById.get(state.finalCard.noteId) ?? null
					: null,
			}))
			.filter((candidate) => !candidate.state.finalCard.noteId || candidate.existingNote === null),
	);
}

async function recoverPreparedCardsByUid(
	client: AnkiClient,
	preparedFiles: PreparedSyncFile[],
	existingNotesById: ReadonlyMap<string, AnkiNoteInfo>,
	runtimeErrors: string[],
): Promise<UidRecoveryResult> {
	const blockedCardKeys = new Set<string>();
	const statesNeedingRecovery = preparedFiles.flatMap((preparedFile) =>
		preparedFile.cards.filter((state) => {
			const noteId = state.finalCard.noteId;
			return !noteId || !existingNotesById.has(noteId);
		}),
	);

	const uidsToRecover = [
		...new Set(
			statesNeedingRecovery
				.map((state) => state.finalCard.uid?.trim() ?? "")
				.filter(Boolean),
		),
	];

	if (uidsToRecover.length === 0) {
		return {
			blockedCardKeys,
			recoveredNoteIds: [],
		};
	}

	try {
		const noteIdsByUid = await client.findNotesByObsidianUid(uidsToRecover);
		const recoveredNoteIds = new Set<string>();

		for (const state of statesNeedingRecovery) {
			const uid = state.finalCard.uid?.trim() ?? "";
			if (!uid) {
				continue;
			}

			const matches = noteIdsByUid.get(uid) ?? [];
			if (matches.length === 1) {
				const [matchedNoteId] = matches;
				if (matchedNoteId) {
					state.finalCard = {
						...state.finalCard,
						noteId: matchedNoteId,
					};
					recoveredNoteIds.add(matchedNoteId);
				}
				continue;
			}

			if (matches.length > 1) {
				blockedCardKeys.add(getCardLocationKey(state.finalCard));
				runtimeErrors.push(
					formatCardError(
						state.finalCard,
						`Multiple Anki notes share ObsidianUid "${uid}". Delete the duplicates in Anki and sync again.`,
					),
				);
			}
		}

		return {
			blockedCardKeys,
			recoveredNoteIds: [...recoveredNoteIds],
		};
	} catch (error) {
		runtimeErrors.push(`Anki UID recovery failed: ${asErrorMessage(error)}`);
		return {
			blockedCardKeys,
			recoveredNoteIds: [],
		};
	}
}

function buildObakNoteInput(
	card: ParsedCard,
	ankiNoteId: string | null,
): ObakNoteInput {
	if (!card.uid) {
		throw new Error(`Missing card UID for ${getCardLocationKey(card)}.`);
	}

	return {
		deckName: card.effectiveDeck,
		tags: card.effectiveTags,
		fields: {
			obsidianUid: card.uid,
			ankiDeck: card.effectiveDeck,
			ankiTags: card.effectiveTags,
			ankiNoteId,
			front: card.frontNormalized,
			back: card.backNormalized,
			obsidianUri: card.obUri,
			obsidianPath: card.filePath,
			obsidianRev: card.rev,
		},
	};
}

function formatCardLocations(cards: Pick<ParsedCard, "filePath" | "startLine">[]): string {
	return cards
		.map((card) => `${card.filePath}:${card.startLine}`)
		.join(", ");
}

function getCardLocationKey(card: Pick<ParsedCard, "filePath" | "startLine">): string {
	return `${card.filePath}:${card.startLine}`;
}

function selectFilesForIncrementalSync(
	plugin: ObakPluginApi,
	indexSnapshot: PluginIndex,
): IncrementalSyncSelection {
	const scanConfigSignature = buildScanConfigSignature(plugin.settings);
	const dirtyPaths = new Set(plugin.getDirtyFilePaths());
	const allFiles = plugin.app.vault.getMarkdownFiles();
	const filesByPath = new Map(allFiles.map((file) => [file.path, file]));
	const staleDirtyPaths = [...dirtyPaths].filter((filePath) => !filesByPath.has(filePath));
	const hasPendingDeletes = indexSnapshot.pendingDeleteNoteIds.length > 0;
	const forceFullScan =
		hasPendingDeletes ||
		indexSnapshot.lastSyncAt === null ||
		indexSnapshot.lastScanConfigHash !== scanConfigSignature;
	const files = forceFullScan
		? allFiles
		: allFiles.filter((file) =>
				shouldIncrementallySyncFile(file, dirtyPaths, indexSnapshot.lastSyncAt),
		  );

	return {
		files,
		scanConfigSignature,
		staleDirtyPaths,
	};
}

function shouldIncrementallySyncFile(
	file: TFile,
	dirtyPaths: ReadonlySet<string>,
	lastSyncAt: number | null,
): boolean {
	if (dirtyPaths.has(file.path)) {
		return true;
	}

	if (lastSyncAt === null) {
		return true;
	}

	return file.stat.mtime > lastSyncAt || file.stat.ctime > lastSyncAt;
}
