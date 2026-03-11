import { basename, dirname, extname, join } from "path";
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

// 一次文件重写操作：把原文某个区间替换成新的 `card-end` 标记。
interface CardRewrite {
	startOffset: number;
	endOffset: number;
	replacement: string;
}

// 准备阶段会同时保留“原卡片”和“归一化后准备用于同步的卡片”，便于比较与回写。
interface PreparedCardState {
	originalCard: ParsedCard;
	finalCard: ParsedCard;
	previousSyncedRev: string | null;
}

// 单文件在进入同步前的准备结果。
interface PreparedScannedFile {
	scannedFile: ScannedFile;
	cards: PreparedCardState[];
	deletedUids: string[];
}

// 进入真正同步阶段前，还会记录文件是否因为补 UID 而被提前重写过。
interface PreparedSyncFile extends PreparedScannedFile {
	fileRewritten: boolean;
}

// 增量同步的文件选择结果。
interface IncrementalSyncSelection {
	files: TFile[];
	scanConfigSignature: string;
	staleDirtyPaths: string[];
}

// 启动或同步前对账缺失文件后的结果。
interface MissingFileReconcileResult {
	missingFilePaths: string[];
	removedUnsyncedCards: number;
	deferred: boolean;
}

// 处理“已删除文件”队列后的汇总信息。
interface DeletedFileProcessingResult {
	changed: boolean;
	filePaths: string[];
	removedUnsyncedCards: number;
}

// 待创建新笔记的候选卡片，同时带上它在 Anki 中是否已存在对应 note。
interface PendingCreateCandidate {
	existingNote: AnkiNoteInfo | null;
	state: PreparedCardState;
}

// 通过 UID 尝试恢复 noteId 的结果。
interface UidRecoveryResult {
	blockedCardKeys: Set<string>;
	recoveredNoteIds: string[];
}

// 扫描期间对 UID 冲突做过滤后的结果。
interface UidConflictFilterResult {
	conflictMessages: string[];
	safeScannedFiles: ScannedFile[];
}

// 只要影响“哪些文件需要重新扫描”的配置发生变化，就要递增这个版本。
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

/**
 * 只校验当前文件的卡片语法，不改动文件、不访问 Anki。
 */
export async function validateMarkdownFile(
	plugin: ObakPluginApi,
	file: TFile,
): Promise<ScannedFile> {
	return scanMarkdownFile(plugin.app, file, plugin.settings);
}

/**
 * 把索引中记录但 vault 中已经不存在的文件处理掉。
 *
 * 职责包括：
 * 1. 标记缺失文件
 * 2. 为已同步卡片排队删除对应 Anki 笔记
 * 3. 直接清理从未同步过的本地卡片索引
 */
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
		// 启动早期 vault 文件列表可能暂时为空；此时若直接对账会误判整库已删除。
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

	// 先把缺失路径打上“已删除待处理”标记，再统一走后续删除逻辑。
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

/**
 * 只刷新本地卡片元数据：
 * - 补 UID
 * - 计算 rev
 * - 继承已知 noteId
 * - 回写 `card-end`
 * - 更新本地索引
 */
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
		// 即便某个文件有解析错误，也会统计进去；只是最终行为会受错误影响。
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

/**
 * 全量重建同步索引。
 * 适合索引损坏、配置变化较大，或需要重新从 vault 现状推导状态时使用。
 */
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

	// 待删 note 队列和“最近全量对账时间”属于外部状态，重建时需要保留。
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

/**
 * 对整库执行完整同步。
 */
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

/**
 * 只同步最近变动过的文件。
 * 如果存在待删 note、从未同步过，或扫描配置发生变化，则会自动退化为全量扫描。
 */
/**
 * Sync a single markdown file without advancing the global incremental sync cursor.
 */
export async function syncMarkdownFileToAnki(
	plugin: Plugin & ObakPluginApi,
	file: TFile,
	options?: SyncExecutionOptions,
): Promise<SyncToAnkiResult> {
	logVerbose(plugin, `Running single-file sync workflow for ${file.path}.`);
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
			"Skipped single-file sync because reconcile was deferred while vault files are still loading.",
			{ filePath: file.path },
		);
		return result;
	}

	return syncCardsToAnkiForFiles(
		plugin,
		[file],
		buildScanConfigSignature(plugin.settings),
		false,
		options,
	);
}

/**
 * Only sync recently changed files.
 * Falls back to a full scan when pending deletes exist, nothing has been synced yet,
 * or scan-affecting settings changed.
 */
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
	// 这是完整同步流程的核心：
	// 1. 扫描文件
	// 2. 连接并准备 Anki
	// 3. 预处理 UID / noteId / deck / 重复项
	// 4. 删除失效笔记
	// 5. 逐卡创建或更新
	// 6. 回写文件与索引
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
		// 只有在确认 AnkiConnect 可用且模型结构正确后，才继续真正同步。
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
		// 预先把所有可能涉及的现有 note 一次性拉下来，减少后续逐卡查询。
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
		// 新卡创建前先确保目标牌组存在；失败时记录错误，但不阻断整个同步流程。
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
		// 通过 UID 找回 noteId 后，再补拉一次详情，保证后续更新阶段拿到完整 note 信息。
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

	// 当前仍然活跃的 note 不应该继续留在待删队列里。
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
			// 有解析错误的文件先不参与删除推断，避免局部语法错误导致误删 Anki 笔记。
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
		// 从未同步过的卡片只需要本地清理，不需要访问 Anki。
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

	if (shouldBackupBeforeBulkDelete(plugin.settings, pendingDeleteIds.length)) {
		try {
			const backupExportConfig = getBulkDeleteBackupExportConfig(plugin.settings);
			reportSyncProgress(options, {
				message: `Exporting deck "${backupExportConfig.deckName}" before deleting ${pendingDeleteIds.length} note(s)...`,
				completed: completedProgressSteps,
				total: totalProgressSteps,
			});
			await client.exportPackage(
				backupExportConfig.deckName,
				backupExportConfig.exportPath,
				true,
			);
			logVerbose(plugin, "Exported deck before bulk delete.", {
				deckName: backupExportConfig.deckName,
				exportPath: backupExportConfig.exportPath,
				pendingDeletes: pendingDeleteIds.length,
				threshold: plugin.settings.backupBeforeBulkDeleteThreshold,
			});
		} catch (error) {
			const message = `Aborted sync before deleting ${pendingDeleteIds.length} note(s): ${asErrorMessage(error)}`;
			result.runtimeErrors.push(message);
			logVerbose(plugin, "Failed while preparing or exporting deck before bulk delete.", error);
			await plugin.savePluginData();
			return result;
		}
	}

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
			// 逐卡决定是跳过、创建还是更新，并同步回最新 noteId/rev。
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
				// 删除阶段失败或文件存在解析错误时，不应贸然删除索引里“这次没扫描到”的旧卡。
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
	// 统一结果初始化，减少各流程手写重复字段。
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
	// 这一阶段的目标是：为每张卡补出稳定 UID、继承 noteId，并计算最新 rev。
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
				// 优先沿用索引中记录的“上次成功同步 rev”，否则退回文件里现存的 rev。
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
		// 旧索引里有、这次扫描结果里没有的 UID，会在后续进入删除判定。
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
		// 新卡如果还没有 UID，会先回写文件，再重新扫描一次，确保后续同步全程使用稳定 UID。
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

	// UID 已经写回文件后，重新扫描一次，后续逻辑全部基于最新文件内容继续。
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
	// 只需要为“最终落地 deck 非空”的卡片准备牌组。
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
	// 单卡同步策略：
	// - 没 deck：报错并跳过
	// - 被预检查阻塞：清空 noteId/rev，等待用户修复
	// - 没有 noteId 或 note 不存在：创建
	// - rev 未变化：跳过更新
	// - 其余：更新现有 note
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
		// 创建时先 addNote，再立刻 update 一次，把 `AnkiNoteId` 字段写成真实值。
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
		// 上次成功同步的 rev 和当前 rev 一致，说明 Anki 内容无需更新。
		result.cardsUnchanged += 1;
		logVerbose(plugin, `Card unchanged; skipped update for ${getCardLocationKey(card)}.`);
		return state;
	}

	try {
		// 更新字段后再同步 deck，确保卡片内容和目标位置都与当前 Markdown 一致。
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
	// 只为“原文件里没有 UID”的卡片生成重写操作。
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
	// 根据最终 UID/noteId/rev 生成新的 `card-end`；没变化就不回写。
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
	// 汇总所有仍然有效的 noteId，便于批量加载 note 信息或从待删队列中移除。
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
				// 如果文件已被用户再次修改，放弃本次重写，避免覆盖最新内容。
				throw new Error(`File changed during rewrite: ${scannedFile.file.path}`);
			}

			let rewritten = current;
			for (const rewrite of [...rewrites].sort(
				(left, right) => right.startOffset - left.startOffset,
			)) {
				// 按偏移从后往前替换，避免前面的替换影响后面的区间位置。
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
	// 只把影响扫描结果的配置纳入签名；配置变化后，增量同步会自动退回全量扫描。
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
			// 如果文件后来又出现了，说明只是临时状态，清掉删除标记即可。
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

		// 已同步卡片进入待删队列；未同步卡片直接从本地索引回收。
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
	// 先收集本轮扫描中“每个 UID 被哪些卡片声明”。
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
			// 同一轮扫描内出现多个相同 UID，直接判为冲突。
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

		// 另一种冲突：当前扫描文件的 UID 与索引里“其他仍存在文件”的 UID 撞车。
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
	// 对潜在新建卡片执行 `canAddNotes` 预检查，提前挡住重复 UID 等错误。
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
	// 只挑出“没有 noteId”或“noteId 已失效”的卡片，作为创建候选。
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
	// 某些卡片文件里 noteId 丢了，但 UID 还在；这时可以尝试按 UID 把 noteId 找回来。
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
				// 唯一匹配时可自动恢复 noteId，避免重复创建 Anki 笔记。
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
				// 一个 UID 对应多条 Anki 笔记时无法自动决策，只能阻塞并让用户手工清理。
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
	// 这里统一收口“同步到 Anki 时到底传哪些字段”，方便创建和更新共用。
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
	// 增量同步并不只是看 dirty 标记：
	// - 若有待删 note，则必须全量扫描
	// - 若从未同步过，则必须全量扫描
	// - 若扫描配置变化，则必须全量扫描
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
	// dirty 优先；否则再根据文件创建/修改时间与上次同步时间比较。
	if (dirtyPaths.has(file.path)) {
		return true;
	}

	if (lastSyncAt === null) {
		return true;
	}

	return file.stat.mtime > lastSyncAt || file.stat.ctime > lastSyncAt;
}
