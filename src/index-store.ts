import type { FileIndexRecord, ParsedCard, PluginIndex } from "./types";

const INDEX_SCHEMA_VERSION = 5;

export function createEmptyPluginIndex(): PluginIndex {
	return {
		schemaVersion: INDEX_SCHEMA_VERSION,
		filesByPath: {},
		pendingDeleteNoteIds: [],
		lastSyncAt: null,
		lastScanConfigHash: null,
		lastFullReconcileAt: null,
	};
}

export function getTrackedFilePathsFromIndex(index: PluginIndex): string[] {
	return Object.entries(index.filesByPath)
		.filter(([, record]) => record.noteIds.length > 0)
		.map(([filePath]) => filePath);
}

export function getTrackedNoteCountFromIndex(index: PluginIndex): number {
	return new Set(
		Object.values(index.filesByPath).flatMap((record) => record.noteIds),
	).size;
}

export function getDeletedFilePathsFromIndex(index: PluginIndex): string[] {
	return Object.entries(index.filesByPath)
		.filter(([, record]) => record.deleted === true && record.noteIds.length > 0)
		.map(([filePath]) => filePath);
}

export function getPendingSyncFilePathsFromIndex(index: PluginIndex): string[] {
	return Object.entries(index.filesByPath)
		.filter(([, record]) => record.pendingSync === true)
		.map(([filePath]) => filePath);
}

export function getNoteIdsForFile(index: PluginIndex, filePath: string): string[] {
	return [...(index.filesByPath[filePath]?.noteIds ?? [])];
}

export function buildNoteOwnerById(index: PluginIndex): Map<string, string> {
	const noteOwnerById = new Map<string, string>();

	for (const [filePath, record] of Object.entries(index.filesByPath)) {
		for (const noteId of record.noteIds) {
			if (!noteOwnerById.has(noteId)) {
				noteOwnerById.set(noteId, filePath);
			}
		}
	}

	return noteOwnerById;
}

export class IndexStore {
	private index: PluginIndex;
	private noteOwnerById: Map<string, string>;

	constructor(snapshot?: PluginIndex) {
		this.index = loadPluginIndex(snapshot);
		this.noteOwnerById = buildNoteOwnerById(this.index);
	}

	getSnapshot(): PluginIndex {
		return clonePluginIndex(this.index);
	}

	getDeletedFilePaths(): string[] {
		return getDeletedFilePathsFromIndex(this.index);
	}

	getPendingDeleteNoteIds(): string[] {
		return [...this.index.pendingDeleteNoteIds];
	}

	getPendingSyncFilePaths(): string[] {
		return getPendingSyncFilePathsFromIndex(this.index);
	}

	markFileDeleted(filePath: string): boolean {
		const record = this.index.filesByPath[filePath];
		if (!record || record.noteIds.length === 0 || record.deleted === true) {
			return false;
		}

		record.deleted = true;
		return true;
	}

	markFilePendingSync(filePath: string): void {
		this.ensureFileRecord(filePath).pendingSync = true;
	}

	queuePendingDelete(noteIds: string[]): void {
		for (const noteId of noteIds) {
			if (!this.index.pendingDeleteNoteIds.includes(noteId)) {
				this.index.pendingDeleteNoteIds.push(noteId);
			}
		}
	}

	dequeuePendingDelete(noteIds: string[]): void {
		if (noteIds.length === 0) {
			return;
		}

		const noteIdSet = new Set(noteIds);
		this.index.pendingDeleteNoteIds = this.index.pendingDeleteNoteIds.filter(
			(noteId) => !noteIdSet.has(noteId),
		);
	}

	clearDeletedFile(filePath: string): void {
		const record = this.index.filesByPath[filePath];
		if (!record) {
			return;
		}

		delete record.deleted;
		this.pruneFileRecord(filePath);
	}

	clearFilePendingSync(filePath: string): void {
		const record = this.index.filesByPath[filePath];
		if (!record) {
			return;
		}

		delete record.pendingSync;
		this.pruneFileRecord(filePath);
	}

	removeFileTracking(filePath: string): void {
		const record = this.index.filesByPath[filePath];
		if (!record) {
			return;
		}

		for (const noteId of record.noteIds) {
			if (this.noteOwnerById.get(noteId) === filePath) {
				this.noteOwnerById.delete(noteId);
			}
		}

		delete this.index.filesByPath[filePath];
	}

	replace(index: PluginIndex): void {
		this.index = clonePluginIndex(index);
		this.noteOwnerById = buildNoteOwnerById(this.index);
	}

	setLastScanConfigHash(signature: string | null): void {
		this.index.lastScanConfigHash = signature;
	}

	setLastSyncAt(timestamp: number | null): void {
		this.index.lastSyncAt = timestamp;
	}

	setLastFullReconcileAt(timestamp: number | null): void {
		this.index.lastFullReconcileAt = timestamp;
	}

	renameFile(oldPath: string, newPath: string): void {
		if (oldPath === newPath) {
			return;
		}

		const record = this.index.filesByPath[oldPath];
		if (!record) {
			return;
		}

		delete this.index.filesByPath[oldPath];
		this.index.filesByPath[newPath] = cloneFileRecord(record);

		for (const noteId of record.noteIds) {
			if (this.noteOwnerById.get(noteId) === oldPath) {
				this.noteOwnerById.set(noteId, newPath);
			}
		}

		this.clearDeletedFile(newPath);
	}

	removeCardsByNoteIds(noteIds: string[]): void {
		if (noteIds.length === 0) {
			return;
		}

		const noteIdSet = new Set(noteIds);

		for (const noteId of noteIdSet) {
			this.noteOwnerById.delete(noteId);
		}

		for (const [filePath, record] of Object.entries(this.index.filesByPath)) {
			const remainingNoteIds = record.noteIds.filter((noteId) => !noteIdSet.has(noteId));
			if (remainingNoteIds.length !== record.noteIds.length) {
				record.noteIds = remainingNoteIds;
			}
			this.pruneFileRecord(filePath);
		}

		this.index.pendingDeleteNoteIds = this.index.pendingDeleteNoteIds.filter(
			(noteId) => !noteIdSet.has(noteId),
		);
	}

	setFileCards(
		filePath: string,
		cards: ParsedCard[],
		options: { preserveUnseen?: boolean } = {},
	): void {
		const preserveUnseen = options.preserveUnseen ?? false;
		const record = this.ensureFileRecord(filePath);
		const previousNoteIds = [...record.noteIds];
		const existingNoteIds = new Set(previousNoteIds);
		const nextNoteIds: string[] = [];

		for (const card of cards) {
			if (!card.noteId) {
				continue;
			}

			nextNoteIds.push(card.noteId);
			const previousOwner = this.noteOwnerById.get(card.noteId);
			if (previousOwner && previousOwner !== filePath) {
				this.removeNoteIdFromFile(previousOwner, card.noteId);
			}
			this.noteOwnerById.set(card.noteId, filePath);
		}

		const nextNoteIdSet = new Set(nextNoteIds);
		if (!preserveUnseen) {
			for (const noteId of existingNoteIds) {
				if (!nextNoteIdSet.has(noteId) && this.noteOwnerById.get(noteId) === filePath) {
					this.noteOwnerById.delete(noteId);
				}
			}
		}

		record.noteIds = preserveUnseen
			? Array.from(new Set([...previousNoteIds, ...nextNoteIds]))
			: nextNoteIds;
		delete record.deleted;
		this.pruneFileRecord(filePath);
	}

	private ensureFileRecord(filePath: string): FileIndexRecord {
		const existingRecord = this.index.filesByPath[filePath];
		if (existingRecord) {
			return existingRecord;
		}

		const nextRecord: FileIndexRecord = { noteIds: [] };
		this.index.filesByPath[filePath] = nextRecord;
		return nextRecord;
	}

	private removeNoteIdFromFile(filePath: string, noteId: string): void {
		const record = this.index.filesByPath[filePath];
		if (!record || !record.noteIds.includes(noteId)) {
			return;
		}

		record.noteIds = record.noteIds.filter((entry) => entry !== noteId);
		if (this.noteOwnerById.get(noteId) === filePath) {
			this.noteOwnerById.delete(noteId);
		}
		this.pruneFileRecord(filePath);
	}

	private pruneFileRecord(filePath: string): void {
		const record = this.index.filesByPath[filePath];
		if (
			record &&
			record.noteIds.length === 0 &&
			record.deleted !== true &&
			record.pendingSync !== true
		) {
			delete this.index.filesByPath[filePath];
		}
	}
}

function loadPluginIndex(snapshot?: unknown): PluginIndex {
	if (!isPluginIndex(snapshot) || snapshot.schemaVersion !== INDEX_SCHEMA_VERSION) {
		return createEmptyPluginIndex();
	}

	return clonePluginIndex(snapshot);
}

function clonePluginIndex(index: PluginIndex): PluginIndex {
	return {
		schemaVersion: index.schemaVersion,
		filesByPath: cloneFileMap(index.filesByPath),
		pendingDeleteNoteIds: [...index.pendingDeleteNoteIds],
		lastSyncAt: index.lastSyncAt,
		lastScanConfigHash: index.lastScanConfigHash,
		lastFullReconcileAt: index.lastFullReconcileAt,
	};
}

function cloneFileMap(fileMap: Record<string, FileIndexRecord>): Record<string, FileIndexRecord> {
	return Object.fromEntries(
		Object.entries(fileMap).map(([filePath, record]) => [filePath, cloneFileRecord(record)]),
	);
}

function cloneFileRecord(record: FileIndexRecord): FileIndexRecord {
	return {
		noteIds: [...record.noteIds],
		...(record.deleted === true ? { deleted: true } : {}),
		...(record.pendingSync === true ? { pendingSync: true } : {}),
	};
}

function isPluginIndex(value: unknown): value is PluginIndex {
	return (
		isRecord(value) &&
		typeof value.schemaVersion === "number" &&
		isFileIndexRecordMap(value.filesByPath) &&
		isStringArray(value.pendingDeleteNoteIds) &&
		isNullableNumber(value.lastSyncAt) &&
		isNullableString(value.lastScanConfigHash) &&
		isNullableNumber(value.lastFullReconcileAt)
	);
}

function isFileIndexRecordMap(value: unknown): value is Record<string, FileIndexRecord> {
	return isRecord(value) && Object.values(value).every(isFileIndexRecord);
}

function isFileIndexRecord(value: unknown): value is FileIndexRecord {
	return (
		isRecord(value) &&
		isStringArray(value.noteIds) &&
		isOptionalTrue(value.deleted) &&
		isOptionalTrue(value.pendingSync)
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalTrue(value: unknown): value is true | undefined {
	return value === undefined || value === true;
}

function isNullableNumber(value: unknown): value is number | null {
	return value === null || typeof value === "number";
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
