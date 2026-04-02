import { basename, dirname, extname, join } from "path";
import type { Plugin, TFile } from "obsidian";
import { AnkiClient, type AnkiNoteInfo } from "./anki-client";
import { OBAK_MODEL_NAME } from "./anki-model";
import {
	buildNoteOwnerById,
	createEmptyPluginIndex,
	getDeletedFilePathsFromIndex,
	getNoteIdsForFile,
	getTrackedFilePathsFromIndex,
	IndexStore,
} from "./index-store";
import { logVerbose } from "./logger";
import { computeCardRevision } from "./normalize";
import { scanMarkdownFile, scanMarkdownFiles } from "./scanner";
import type { ObakSettings } from "./settings";
import { serializeCardEnd } from "./syntax";
import type {
	LocalRefreshResult,
	ParsedCard,
	PluginIndex,
	ScannedFile,
	SyncExecutionOptions,
	SyncProgressUpdate,
	SyncToAnkiResult,
	ObakPluginApi,
} from "./types";

interface CardRewrite {
	startOffset: number;
	endOffset: number;
	replacement: string;
}

interface PreparedCardState {
	originalCard: ParsedCard;
	finalCard: ParsedCard;
	computedRev: string;
	needsRetry: boolean;
}

interface PreparedScannedFile {
	scannedFile: ScannedFile;
	cards: PreparedCardState[];
	deletedNoteIds: string[];
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

interface DeletedFileSyncSelection {
	files: TFile[];
	missingFilePaths: string[];
	restoredFilePaths: string[];
}

interface NoteIdConflictFilterResult {
	conflictMessages: string[];
	safeScannedFiles: ScannedFile[];
}

interface FullVaultDeletePolicy {
	allowImplicitDeletes: boolean;
}

const SCAN_CONFIG_SIGNATURE_VERSION = 2;
const INVALID_BACKUP_FILE_NAME_CHARACTERS = new Set([
	"<",
	">",
	":",
	"\"",
	"/",
	"\\",
	"|",
	"?",
	"*",
]);

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
	const trackedPaths = getTrackedFilePathsFromIndex(snapshot);
	const missingFilePaths = trackedPaths.filter((filePath) => !currentPaths.has(filePath));
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

	plugin.indexStore.setLastFullReconcileAt(Date.now());
	if (changed) {
		await plugin.savePluginData();
	}

	return {
		missingFilePaths,
		removedUnsyncedCards: 0,
		deferred: false,
	};
}

export async function refreshLocalMetadataForFiles(
	plugin: Plugin & ObakPluginApi,
	files: TFile[],
): Promise<LocalRefreshResult> {
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const scannedFiles = await filterScannedFilesWithNoteIdConflicts(
		plugin,
		await scanMarkdownFiles(plugin.app, files, plugin.settings),
		indexSnapshot,
	);
	const result = createLocalResult();
	const cleanFilePaths: string[] = [];
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
			plugin.indexStore.markFilePendingSync(scannedFile.file.path);
			continue;
		}

		if (rewritten) {
			result.filesRewritten += 1;
		}

		plugin.indexStore.setFileCards(
			scannedFile.file.path,
			prepared.cards.map((card) => card.finalCard),
			{ preserveUnseen: true },
		);
		syncFilePendingState(plugin, scannedFile.file.path, hasUnsyncedCards(prepared.cards));
		if (!hasUnsyncedCards(prepared.cards)) {
			cleanFilePaths.push(scannedFile.file.path);
		}
	}

	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	return result;
}

export async function rebuildSyncIndex(
	plugin: Plugin & ObakPluginApi,
): Promise<LocalRefreshResult> {
	const files = plugin.app.vault.getMarkdownFiles();
	const currentFilePaths = new Set(files.map((file) => file.path));
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const scannedFiles = await filterScannedFilesWithNoteIdConflicts(
		plugin,
		await scanMarkdownFiles(plugin.app, files, plugin.settings),
		indexSnapshot,
	);
	const rebuiltStore = new IndexStore(createEmptyPluginIndex());
	const result = createLocalResult();
	const cleanFilePaths: string[] = [];

	if (scannedFiles.conflictMessages.length > 0) {
		result.runtimeErrors.push(...scannedFiles.conflictMessages);
		result.runtimeErrors.push(
			"Rebuild aborted because duplicate card id conflicts must be resolved first.",
		);
		return result;
	}

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
			rebuiltStore.markFilePendingSync(scannedFile.file.path);
			continue;
		}

		if (rewritten) {
			result.filesRewritten += 1;
		}

		rebuiltStore.setFileCards(
			scannedFile.file.path,
			prepared.cards.map((card) => card.finalCard),
		);
		if (hasUnsyncedCards(prepared.cards)) {
			rebuiltStore.markFilePendingSync(scannedFile.file.path);
		} else {
			cleanFilePaths.push(scannedFile.file.path);
		}
	}

	const nextIndex = rebuiltStore.getSnapshot();
	nextIndex.pendingDeleteNoteIds = plugin.indexStore.getPendingDeleteNoteIds();
	nextIndex.lastFullReconcileAt = Date.now();
	mergeDeletedFileTrackingForRebuild(nextIndex, indexSnapshot, currentFilePaths);

	plugin.indexStore.replace(nextIndex);
	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	return result;
}

export async function syncCardsToAnki(
	plugin: Plugin & ObakPluginApi,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	if (shouldDeferSyncUntilVaultReady(plugin)) {
		return createVaultLoadingDeferredResult(plugin, "full sync");
	}

	reportSyncProgress(options, {
		message: "Preparing full sync...",
		completed: 0,
		total: null,
	});
	return syncCardsToAnkiForFiles(
		plugin,
		plugin.app.vault.getMarkdownFiles(),
		buildScanConfigSignature(plugin.settings),
		true,
		true,
		options,
	);
}

export async function syncMarkdownFileToAnki(
	plugin: Plugin & ObakPluginApi,
	file: TFile,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	if (shouldDeferSyncUntilVaultReady(plugin)) {
		return createVaultLoadingDeferredResult(plugin, "single-file sync", {
			filePath: file.path,
		});
	}

	reportSyncProgress(options, {
		message: "Preparing file sync...",
		completed: 0,
		total: null,
	});
	return syncCardsToAnkiForFiles(
		plugin,
		[file],
		buildScanConfigSignature(plugin.settings),
		false,
		false,
		options,
	);
}

export async function syncChangedCardsToAnki(
	plugin: Plugin & ObakPluginApi,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	if (shouldDeferSyncUntilVaultReady(plugin)) {
		return createVaultLoadingDeferredResult(plugin, "incremental sync");
	}

	reportSyncProgress(options, {
		message: "Preparing incremental sync...",
		completed: 0,
		total: null,
	});
	const selection = selectFilesForIncrementalSync(
		plugin,
		plugin.indexStore.getSnapshot(),
	);
	plugin.clearFilesDirty(selection.staleDirtyPaths);

	if (
		selection.files.length === 0 &&
		plugin.indexStore.getPendingDeleteNoteIds().length === 0 &&
		plugin.indexStore.getDeletedFilePaths().length === 0 &&
		plugin.indexStore.getPendingSyncFilePaths().length === 0
	) {
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
		false,
		options,
	);
}

async function syncCardsToAnkiForFiles(
	plugin: Plugin & ObakPluginApi,
	files: TFile[],
	scanConfigSignature: string,
	advanceSyncCursor: boolean,
	fullVaultComparison: boolean,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	const indexSnapshot = plugin.indexStore.getSnapshot();
	const deletedFileSelection = resolveDeletedFilesForSync(plugin, files, indexSnapshot);
	const filesToScan = deletedFileSelection.files;
	const queuedDeleteIds = plugin.indexStore.getPendingDeleteNoteIds();

	if (
		filesToScan.length === 0 &&
		queuedDeleteIds.length === 0 &&
		deletedFileSelection.missingFilePaths.length === 0
	) {
		if (advanceSyncCursor) {
			plugin.indexStore.setLastSyncAt(Date.now());
			plugin.indexStore.setLastScanConfigHash(scanConfigSignature);
			await plugin.savePluginData();
		}

		return createSyncResult();
	}

	reportSyncProgress(options, {
		message: "Scanning markdown files...",
		completed: 0,
		total: null,
	});

	const allScannedFiles = await scanMarkdownFiles(plugin.app, filesToScan, plugin.settings);
	const scannedFiles = await filterScannedFilesWithNoteIdConflicts(
		plugin,
		allScannedFiles,
		indexSnapshot,
	);
	const result = createSyncResult();
	result.runtimeErrors.push(...scannedFiles.conflictMessages);

	const client = new AnkiClient(plugin.settings);
	const cleanFilePaths: string[] = [];
	const totalCardsToSync = scannedFiles.safeScannedFiles.reduce(
		(count, scannedFile) => count + scannedFile.cards.length,
		0,
	);
	const totalProgressSteps = 6 + totalCardsToSync;
	let completedProgressSteps = 1;

	reportSyncProgress(options, {
		message: `Scanned ${scannedFiles.safeScannedFiles.length} file(s) for sync.`,
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

	try {
		await client.ensureReadyForSync();
		completedProgressSteps += 1;
		reportSyncProgress(options, {
			message: "Connected to Anki and verified the Obak model.",
			completed: completedProgressSteps,
			total: totalProgressSteps,
		});
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		return result;
	}

	const preparedFiles = await Promise.all(
		scannedFiles.safeScannedFiles.map((scannedFile) =>
			prepareScannedFile(scannedFile, indexSnapshot),
		),
	);
	const fullVaultDeletePolicy = createFullVaultDeletePolicy(
		plugin,
		fullVaultComparison,
		allScannedFiles,
		scannedFiles,
	);
	const initialActiveNoteIds = collectActiveNoteIds(preparedFiles);
	let existingNotesById = new Map<string, AnkiNoteInfo>();

	try {
		if (fullVaultComparison) {
			existingNotesById = await client.getNotesInfo(await client.findObakNoteIds());
		} else {
			existingNotesById = await client.getNotesInfo([...initialActiveNoteIds]);
		}
		completedProgressSteps += 1;
		reportSyncProgress(options, {
			message: "Loaded existing note information from Anki.",
			completed: completedProgressSteps,
			total: totalProgressSteps,
		});
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		await plugin.savePluginData();
		return result;
	}

	const validExistingNotesById = new Map(
		[...existingNotesById.entries()].filter(
			([, note]) => note.modelName === OBAK_MODEL_NAME,
		),
	);
	const invalidNoteIds = new Set(
		[...initialActiveNoteIds].filter((noteId) => !validExistingNotesById.has(noteId)),
	);
	resetPreparedCardsWithInvalidIds(preparedFiles, invalidNoteIds);

	try {
		await client.ensureDecksExist(collectDecksForCards(preparedFiles));
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
	}

	completedProgressSteps += 1;
	reportSyncProgress(options, {
		message: "Finished pre-sync validation checks.",
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

	const activeNoteIds = collectActiveNoteIds(preparedFiles);
	const restoredDeletedFileNoteIds = collectTrackedNoteIdsForFilePaths(
		indexSnapshot,
		deletedFileSelection.restoredFilePaths,
	);
	plugin.indexStore.dequeuePendingDelete([
		...new Set([...activeNoteIds, ...restoredDeletedFileNoteIds]),
	]);

	const deleteContext = await prepareDeleteContext(
		plugin,
		client,
		indexSnapshot,
		preparedFiles,
		validExistingNotesById,
		deletedFileSelection,
		fullVaultDeletePolicy,
		result,
	);
	const deletePhaseSucceeded = await executeDeletePhase(
		plugin,
		client,
		deleteContext.confirmedDeleteIds,
		result,
		options,
		completedProgressSteps,
		totalProgressSteps,
	);

	if (deletePhaseSucceeded) {
		for (const filePath of deletedFileSelection.missingFilePaths) {
			plugin.indexStore.removeFileTracking(filePath);
		}
	}

	completedProgressSteps += 1;
	reportSyncProgress(options, {
		message:
			deleteContext.confirmedDeleteIds.length > 0
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
			const existingNote = state.finalCard.noteId
				? validExistingNotesById.get(state.finalCard.noteId) ?? null
				: null;
			syncedStates.push(
				await syncPreparedCard(plugin, client, state, existingNote, result),
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
		const fileNeedsRetry =
			scannedFile.errors.length > 0 ||
			syncedStates.some((state) => state.needsRetry) ||
			syncedStates.some((state) => !state.finalCard.noteId) ||
			(rewriteRequired && !rewritten);

		if (rewritten) {
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
		syncFilePendingState(plugin, scannedFile.file.path, fileNeedsRetry);

		if (fileNeedsRetry) {
			plugin.markFileDirty(scannedFile.file.path);
		} else {
			cleanFilePaths.push(scannedFile.file.path);
		}
	}

	completedProgressSteps += processedCards;
	const emptyDeckCleanupResult = await cleanupEmptyScopedDecks(
		plugin,
		client,
		result,
		options,
		completedProgressSteps,
		totalProgressSteps,
	);
	completedProgressSteps += 1;
	reportSyncProgress(options, {
		message: emptyDeckCleanupResult.statusMessage,
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

	if (advanceSyncCursor) {
		plugin.indexStore.setLastSyncAt(Date.now());
		plugin.indexStore.setLastScanConfigHash(scanConfigSignature);
	}

	await plugin.savePluginData();
	plugin.clearFilesDirty(cleanFilePaths);
	reportSyncProgress(options, {
		message: `Finished syncing ${result.cardsProcessed} card(s).`,
		completed: totalProgressSteps,
		total: totalProgressSteps,
	});
	return result;
}

async function cleanupEmptyScopedDecks(
	plugin: ObakPluginApi,
	client: AnkiClient,
	result: SyncToAnkiResult,
	options: SyncExecutionOptions | undefined,
	completedProgressSteps: number,
	totalProgressSteps: number,
): Promise<{ deletedDeckNames: string[]; statusMessage: string }> {
	if (!plugin.settings.cleanupEmptyDecksEnabled) {
		return {
			deletedDeckNames: [],
			statusMessage: "Skipped empty deck cleanup because the setting is disabled.",
		};
	}

	const rootDeck = plugin.settings.defaultDeck.trim();
	if (!rootDeck) {
		return {
			deletedDeckNames: [],
			statusMessage: "Skipped empty deck cleanup because the root deck is empty.",
		};
	}

	reportSyncProgress(options, {
		message: `Checking for empty decks under "${rootDeck}"...`,
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});

	try {
		const deletedDeckNames = await client.cleanupEmptyDecksUnderRoot(rootDeck);
		if (deletedDeckNames.length > 0) {
			logVerbose(plugin, "Deleted empty decks under the configured root deck.", {
				rootDeck,
				deletedDeckNames,
			});
		}

		return {
			deletedDeckNames,
			statusMessage:
				deletedDeckNames.length > 0
					? `Deleted ${deletedDeckNames.length} empty deck(s) under "${rootDeck}".`
					: `No empty decks needed cleanup under "${rootDeck}".`,
		};
	} catch (error) {
		result.runtimeErrors.push(
			`Failed to clean up empty decks under "${rootDeck}": ${asErrorMessage(error)}`,
		);
		return {
			deletedDeckNames: [],
			statusMessage: `Empty deck cleanup failed under "${rootDeck}".`,
		};
	}
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

async function prepareDeleteContext(
	plugin: ObakPluginApi,
	client: AnkiClient,
	indexSnapshot: PluginIndex,
	preparedFiles: PreparedScannedFile[],
	validExistingNotesById: ReadonlyMap<string, AnkiNoteInfo>,
	deletedFileSelection: DeletedFileSyncSelection,
	fullVaultDeletePolicy: FullVaultDeletePolicy,
	result: SyncToAnkiResult,
): Promise<{ confirmedDeleteIds: string[] }> {
	const activeNoteIds = collectActiveNoteIds(preparedFiles);
	const deleteNoteIds = new Set<string>(plugin.indexStore.getPendingDeleteNoteIds());
	const trackedDeletedNoteIds = collectTrackedNoteIdsForFilePaths(
		indexSnapshot,
		deletedFileSelection.missingFilePaths,
	);

	for (const noteId of trackedDeletedNoteIds) {
		if (!activeNoteIds.has(noteId)) {
			deleteNoteIds.add(noteId);
		}
	}

	for (const preparedFile of preparedFiles) {
		if (preparedFile.scannedFile.errors.length > 0) {
			continue;
		}

		for (const noteId of preparedFile.deletedNoteIds) {
			if (!activeNoteIds.has(noteId)) {
				deleteNoteIds.add(noteId);
			}
		}
	}

	if (fullVaultDeletePolicy.allowImplicitDeletes) {
		for (const noteId of validExistingNotesById.keys()) {
			if (!activeNoteIds.has(noteId)) {
				deleteNoteIds.add(noteId);
			}
		}
	} else {
		const implicitDeleteNoteIds = [...validExistingNotesById.keys()].filter(
			(noteId) => !activeNoteIds.has(noteId) && !deleteNoteIds.has(noteId),
		);
		if (implicitDeleteNoteIds.length > 0) {
			result.runtimeErrors.push(
				`Skipped implicit full-vault delete for ${implicitDeleteNoteIds.length} note(s) because the full sync scan was not fully trusted. Fix parse errors or duplicate card ids, then run full sync again.`,
			);
		}
	}

	plugin.indexStore.queuePendingDelete([...deleteNoteIds]);
	const pendingDeleteIds = plugin.indexStore.getPendingDeleteNoteIds();
	if (pendingDeleteIds.length === 0) {
		return { confirmedDeleteIds: [] };
	}

	try {
		const existingDeleteNotes = await client.getNotesInfo(pendingDeleteIds);
		const missingDeleteIds = pendingDeleteIds.filter(
			(noteId) => !existingDeleteNotes.has(noteId),
		);
		if (missingDeleteIds.length > 0) {
			plugin.indexStore.removeCardsByNoteIds(missingDeleteIds);
		}

		return {
			confirmedDeleteIds: pendingDeleteIds.filter((noteId) =>
				existingDeleteNotes.has(noteId),
			),
		};
	} catch (error) {
		result.runtimeErrors.push(`Failed to verify notes pending deletion: ${asErrorMessage(error)}`);
		return {
			confirmedDeleteIds: pendingDeleteIds,
		};
	}
}

async function executeDeletePhase(
	plugin: ObakPluginApi,
	client: AnkiClient,
	confirmedDeleteIds: string[],
	result: SyncToAnkiResult,
	options: SyncExecutionOptions | undefined,
	completedProgressSteps: number,
	totalProgressSteps: number,
): Promise<boolean> {
	if (confirmedDeleteIds.length === 0) {
		return true;
	}

	if (shouldBackupBeforeBulkDelete(plugin.settings, confirmedDeleteIds.length)) {
		try {
			const backupExportConfig = getBulkDeleteBackupExportConfig(plugin.settings);
			reportSyncProgress(options, {
				message: `Exporting deck "${backupExportConfig.deckName}" before deleting ${confirmedDeleteIds.length} note(s)...`,
				completed: completedProgressSteps,
				total: totalProgressSteps,
			});
			await client.exportPackage(
				backupExportConfig.deckName,
				backupExportConfig.exportPath,
				true,
			);
		} catch (error) {
			result.runtimeErrors.push(
				`Aborted sync before deleting ${confirmedDeleteIds.length} note(s): ${asErrorMessage(error)}`,
			);
			return false;
		}
	}

	reportSyncProgress(options, {
		message: `Deleting ${confirmedDeleteIds.length} note(s) removed from the vault...`,
		completed: completedProgressSteps,
		total: totalProgressSteps,
	});
	try {
		await client.deleteNotes(confirmedDeleteIds);
		plugin.indexStore.removeCardsByNoteIds(confirmedDeleteIds);
		result.cardsDeleted += confirmedDeleteIds.length;
		return true;
	} catch (error) {
		result.runtimeErrors.push(asErrorMessage(error));
		return false;
	}
}

function shouldDeferSyncUntilVaultReady(plugin: ObakPluginApi): boolean {
	const trackedFiles = getTrackedFilePathsFromIndex(plugin.indexStore.getSnapshot()).length;
	const currentFiles = plugin.app.vault.getMarkdownFiles().length;
	return trackedFiles > 0 && currentFiles === 0;
}

function createFullVaultDeletePolicy(
	plugin: ObakPluginApi,
	fullVaultComparison: boolean,
	allScannedFiles: readonly ScannedFile[],
	scannedFiles: NoteIdConflictFilterResult,
): FullVaultDeletePolicy {
	if (!fullVaultComparison) {
		return {
			allowImplicitDeletes: false,
		};
	}

	const hasParseErrors = allScannedFiles.some((scannedFile) => scannedFile.errors.length > 0);
	const hasConflicts = scannedFiles.conflictMessages.length > 0;

	return {
		allowImplicitDeletes:
			plugin.app.workspace.layoutReady && !hasParseErrors && !hasConflicts,
	};
}

function createVaultLoadingDeferredResult(
	plugin: ObakPluginApi,
	label: string,
	details?: Record<string, unknown>,
): SyncToAnkiResult {
	const result = createSyncResult();
	result.runtimeErrors.push(
		"Vault markdown files are still loading. Sync was skipped to avoid missing files; wait for Obsidian to finish loading and try again.",
	);
	logVerbose(plugin, `Skipped ${label} because the vault markdown file list is still empty.`);
	if (details !== undefined) {
		logVerbose(plugin, `Skipped ${label} details.`, details);
	}

	return result;
}

async function prepareScannedFile(
	scannedFile: ScannedFile,
	indexSnapshot: PluginIndex,
): Promise<PreparedScannedFile> {
	const cards = await Promise.all(
		scannedFile.cards.map(async (originalCard) => {
			const computedRev = await computeCardRevision({
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
					noteId: originalCard.noteId,
				},
				computedRev,
				needsRetry: false,
			};
		}),
	);

	const oldNoteIds = new Set(getNoteIdsForFile(indexSnapshot, scannedFile.file.path));
	const newNoteIds = new Set(
		cards
			.map((card) => card.finalCard.noteId)
			.filter((noteId): noteId is string => Boolean(noteId)),
	);

	return {
		scannedFile,
		cards,
		deletedNoteIds: [...oldNoteIds].filter((noteId) => !newNoteIds.has(noteId)),
	};
}

async function syncPreparedCard(
	plugin: ObakPluginApi,
	client: AnkiClient,
	state: PreparedCardState,
	existingNote: AnkiNoteInfo | null,
	result: SyncToAnkiResult,
): Promise<PreparedCardState> {
	const card = state.finalCard;
	const existingRev = getAnkiStoredRev(existingNote);

	if (!card.effectiveDeck) {
		result.runtimeErrors.push(formatCardError(card, "Card deck is empty."));
		return {
			...state,
			finalCard: card,
			needsRetry: Boolean(card.noteId),
		};
	}

	if (!card.noteId || existingNote === null) {
		const obakSyncId = generateObakSyncId();
		try {
			const noteId = await client.addObakNote(
				buildObakNoteInput(card, {
					ankiNoteId: null,
					obakSyncId,
					obsidianRev: state.computedRev,
				}),
			);
			await client.updateObakNote(
				noteId,
				buildObakNoteInput(card, {
					ankiNoteId: noteId,
					obakSyncId,
					obsidianRev: state.computedRev,
				}),
			);
			result.cardsCreated += 1;
			return {
				...state,
				finalCard: {
					...card,
					noteId,
				},
				needsRetry: false,
			};
		} catch (error) {
			result.runtimeErrors.push(formatCardError(card, asErrorMessage(error)));
			return {
				...state,
				finalCard: {
					...card,
					noteId: null,
				},
				needsRetry: true,
			};
		}
	}

	if (existingRev === state.computedRev) {
		result.cardsUnchanged += 1;
		return {
			...state,
			finalCard: card,
			needsRetry: false,
		};
	}

	const obakSyncId = existingNote.fields["ObakSyncId"]?.trim() || generateObakSyncId();
	try {
		await client.changeDeck(existingNote.cards, card.effectiveDeck);
		await client.updateObakNote(
			card.noteId,
			buildObakNoteInput(card, {
				ankiNoteId: card.noteId,
				obakSyncId,
				obsidianRev: state.computedRev,
			}),
		);
		result.cardsUpdated += 1;
		return {
			...state,
			finalCard: card,
			needsRetry: false,
		};
	} catch (error) {
		result.runtimeErrors.push(formatCardError(card, asErrorMessage(error)));
		return {
			...state,
			finalCard: card,
			needsRetry: true,
		};
	}
}

function resetPreparedCardsWithInvalidIds(
	preparedFiles: PreparedScannedFile[],
	invalidNoteIds: ReadonlySet<string>,
): void {
	for (const preparedFile of preparedFiles) {
		for (const state of preparedFile.cards) {
			const noteId = state.finalCard.noteId;
			if (!noteId || !invalidNoteIds.has(noteId)) {
				continue;
			}

			state.finalCard = {
				...state.finalCard,
				noteId: null,
			};
		}
	}
}

function buildCardRewrites(cards: PreparedCardState[]): CardRewrite[] {
	return cards
		.map((card) => {
			const replacement = serializeCardEnd({
				noteId: card.finalCard.noteId,
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

function collectActiveNoteIds(preparedFiles: PreparedScannedFile[]): Set<string> {
	return new Set(
		preparedFiles.flatMap((preparedFile) =>
			preparedFile.cards
				.map((state) => state.finalCard.noteId)
				.filter((noteId): noteId is string => Boolean(noteId)),
		),
	);
}

function collectDecksForCards(preparedFiles: PreparedScannedFile[]): string[] {
	return preparedFiles.flatMap((preparedFile) =>
		preparedFile.cards
			.map((state) => state.finalCard.effectiveDeck)
			.filter(Boolean),
	);
}

function hasUnsyncedCards(cards: PreparedCardState[]): boolean {
	return cards.some((card) => !card.finalCard.noteId);
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

function reportSyncProgress(
	options: SyncExecutionOptions | undefined,
	update: SyncProgressUpdate,
): void {
	options?.onProgress?.(update);
}

function shouldBackupBeforeBulkDelete(
	settings: Pick<
		ObakSettings,
		"backupBeforeBulkDeleteEnabled" | "backupBeforeBulkDeleteThreshold"
	>,
	pendingDeleteCount: number,
): boolean {
	return (
		settings.backupBeforeBulkDeleteEnabled &&
		pendingDeleteCount > settings.backupBeforeBulkDeleteThreshold
	);
}

function getBulkDeleteBackupExportConfig(
	settings: Pick<
		ObakSettings,
		"defaultDeck" | "backupBeforeBulkDeleteExportPath"
	>,
): {
	deckName: string;
	exportPath: string;
} {
	const deckName = settings.defaultDeck.trim();
	if (!deckName) {
		throw new Error(
			'Default deck is empty. Set "Default deck" to the deck that contains your Obsidian cards before enabling bulk delete backup.',
		);
	}

	const exportPath = settings.backupBeforeBulkDeleteExportPath.trim();
	if (!exportPath) {
		throw new Error('Bulk delete backup export path is empty.');
	}

	return {
		deckName,
		exportPath: buildBulkDeleteBackupExportPath(exportPath, deckName),
	};
}

function buildBulkDeleteBackupExportPath(
	configuredPath: string,
	deckName: string,
): string {
	const timestamp = formatBackupTimestamp(new Date());

	if (/\.apkg$/i.test(configuredPath)) {
		const extension = extname(configuredPath) || ".apkg";
		const baseName = basename(configuredPath, extension);
		const parentDirectory = dirname(configuredPath);
		return join(
			parentDirectory,
			`${sanitizeBackupFileName(baseName)}-${timestamp}.apkg`,
		);
	}

	return join(
		configuredPath,
		`${sanitizeBackupFileName(deckName)}-${timestamp}.apkg`,
	);
}

function formatBackupTimestamp(date: Date): string {
	return [
		date.getFullYear(),
		padTimestampPart(date.getMonth() + 1),
		padTimestampPart(date.getDate()),
		padTimestampPart(date.getHours()),
		padTimestampPart(date.getMinutes()),
		padTimestampPart(date.getSeconds()),
	].join("");
}

function padTimestampPart(value: number): string {
	return String(value).padStart(2, "0");
}

function sanitizeBackupFileName(value: string): string {
	const sanitized = replaceInvalidBackupFileNameCharacters(value.trim())
		.replace(/\s+/g, "-")
		.replace(/[. ]+$/g, "");

	return sanitized || "obak-backup";
}

function replaceInvalidBackupFileNameCharacters(value: string): string {
	let sanitized = "";
	let inInvalidSequence = false;

	for (const char of value) {
		if (isInvalidBackupFileNameCharacter(char)) {
			if (!inInvalidSequence) {
				sanitized += "-";
				inInvalidSequence = true;
			}
			continue;
		}

		sanitized += char;
		inInvalidSequence = false;
	}

	return sanitized;
}

function isInvalidBackupFileNameCharacter(char: string): boolean {
	return (
		INVALID_BACKUP_FILE_NAME_CHARACTERS.has(char) ||
		char.charCodeAt(0) < 0x20
	);
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

function resolveDeletedFilesForSync(
	plugin: ObakPluginApi,
	files: TFile[],
	indexSnapshot: PluginIndex,
): DeletedFileSyncSelection {
	const selectedFilesByPath = new Map(files.map((file) => [file.path, file]));
	const vaultFilesByPath = new Map(
		plugin.app.vault.getMarkdownFiles().map((file) => [file.path, file]),
	);
	const missingFilePaths: string[] = [];
	const restoredFilePaths: string[] = [];

	for (const filePath of getDeletedFilePathsFromIndex(indexSnapshot)) {
		const restoredFile = vaultFilesByPath.get(filePath);
		if (restoredFile) {
			restoredFilePaths.push(filePath);
			selectedFilesByPath.set(filePath, selectedFilesByPath.get(filePath) ?? restoredFile);
			continue;
		}

		missingFilePaths.push(filePath);
	}

	return {
		files: [...selectedFilesByPath.values()],
		missingFilePaths,
		restoredFilePaths,
	};
}

function collectTrackedNoteIdsForFilePaths(
	indexSnapshot: PluginIndex,
	filePaths: Iterable<string>,
): string[] {
	const noteIds = new Set<string>();

	for (const filePath of filePaths) {
		for (const noteId of getNoteIdsForFile(indexSnapshot, filePath)) {
			noteIds.add(noteId);
		}
	}

	return [...noteIds];
}

function mergeDeletedFileTrackingForRebuild(
	nextIndex: PluginIndex,
	previousIndex: PluginIndex,
	currentFilePaths: ReadonlySet<string>,
): void {
	const nextNoteOwnerById = buildNoteOwnerById(nextIndex);

	for (const filePath of getDeletedFilePathsFromIndex(previousIndex)) {
		if (currentFilePaths.has(filePath)) {
			continue;
		}

		const preservedNoteIds = getNoteIdsForFile(previousIndex, filePath).filter(
			(noteId) => !nextNoteOwnerById.has(noteId),
		);
		if (preservedNoteIds.length === 0) {
			continue;
		}

		nextIndex.filesByPath[filePath] = {
			noteIds: [...preservedNoteIds],
			deleted: true,
		};
		for (const noteId of preservedNoteIds) {
			nextNoteOwnerById.set(noteId, filePath);
		}
	}
}

async function filterScannedFilesWithNoteIdConflicts(
	plugin: ObakPluginApi,
	scannedFiles: ScannedFile[],
	indexSnapshot: PluginIndex,
): Promise<NoteIdConflictFilterResult> {
	const claimsByNoteId = new Map<string, ParsedCard[]>();
	const noteOwnerById = buildNoteOwnerById(indexSnapshot);
	const scannedFilePaths = new Set(scannedFiles.map((scannedFile) => scannedFile.file.path));
	const conflictMessages: string[] = [];
	const conflictedFilePaths = new Set<string>();

	for (const scannedFile of scannedFiles) {
		for (const card of scannedFile.cards) {
			if (!card.noteId) {
				continue;
			}

			const claims = claimsByNoteId.get(card.noteId) ?? [];
			claims.push(card);
			claimsByNoteId.set(card.noteId, claims);
		}
	}

	for (const [noteId, claims] of claimsByNoteId.entries()) {
		if (claims.length > 1) {
			conflictMessages.push(
				`Duplicate card id "${noteId}" found at ${formatCardLocations(claims)}. Keep each card id unique across the vault.`,
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

		const existingFilePath = noteOwnerById.get(noteId);
		if (
			existingFilePath &&
			existingFilePath !== claim.filePath &&
			plugin.app.vault.getFileByPath(existingFilePath) &&
			!scannedFilePaths.has(existingFilePath)
		) {
			conflictMessages.push(
				`Duplicate card id "${noteId}" at ${claim.filePath}:${claim.startLine} conflicts with ${existingFilePath}.`,
			);
			conflictedFilePaths.add(claim.filePath);
		}
	}

	for (const filePath of conflictedFilePaths) {
		plugin.markFileDirty(filePath);
		plugin.indexStore.markFilePendingSync(filePath);
	}

	return {
		conflictMessages,
		safeScannedFiles: scannedFiles.filter(
			(scannedFile) => !conflictedFilePaths.has(scannedFile.file.path),
		),
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
	const pendingSyncFilePaths = new Set(plugin.indexStore.getPendingSyncFilePaths());
	const allFiles = plugin.app.vault.getMarkdownFiles();
	const filesByPath = new Map(allFiles.map((file) => [file.path, file]));
	const staleDirtyPaths = [...dirtyPaths].filter((filePath) => !filesByPath.has(filePath));
	const forceFullScan =
		indexSnapshot.lastSyncAt === null ||
		indexSnapshot.lastScanConfigHash !== scanConfigSignature;
	const files = forceFullScan
		? allFiles
		: allFiles.filter((file) =>
				shouldIncrementallySyncFile(
					file,
					dirtyPaths,
					pendingSyncFilePaths,
					indexSnapshot.lastSyncAt,
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
	dirtyPaths: ReadonlySet<string>,
	pendingSyncFilePaths: ReadonlySet<string>,
	lastSyncAt: number | null,
): boolean {
	if (dirtyPaths.has(file.path) || pendingSyncFilePaths.has(file.path)) {
		return true;
	}

	if (lastSyncAt === null) {
		return true;
	}

	return file.stat.mtime > lastSyncAt || file.stat.ctime > lastSyncAt;
}

function buildObakNoteInput(
	card: ParsedCard,
	options: {
		ankiNoteId: string | null;
		obakSyncId: string;
		obsidianRev: string;
	},
): {
	deckName: string;
	fields: {
		obakSyncId: string;
		ankiDeck: string;
		ankiNoteId: string | null;
		ankiTags: string[];
		back: string;
		front: string;
		obsidianPath: string;
		obsidianRev: string;
		obsidianUri: string;
	};
	tags: string[];
} {
	return {
		deckName: card.effectiveDeck,
		tags: card.effectiveTags,
		fields: {
			obakSyncId: options.obakSyncId,
			ankiDeck: card.effectiveDeck,
			ankiTags: card.effectiveTags,
			ankiNoteId: options.ankiNoteId,
			front: card.frontNormalized,
			back: card.backNormalized,
			obsidianUri: card.obUri,
			obsidianPath: card.filePath,
			obsidianRev: options.obsidianRev,
		},
	};
}

function generateObakSyncId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID().replace(/-/g, "");
	}

	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function getAnkiStoredRev(note: AnkiNoteInfo | null): string | null {
	const value = note?.fields["ObsidianRev"]?.trim();
	return value ? value : null;
}

function syncFilePendingState(
	plugin: ObakPluginApi,
	filePath: string,
	isPending: boolean,
): void {
	if (isPending) {
		plugin.indexStore.markFilePendingSync(filePath);
		return;
	}

	plugin.indexStore.clearFilePendingSync(filePath);
}
