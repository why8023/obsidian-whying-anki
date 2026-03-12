import type { ParsedCard, PluginIndex } from "./types";

const INDEX_SCHEMA_VERSION = 4;

export function createEmptyPluginIndex(): PluginIndex {
	return {
		schemaVersion: INDEX_SCHEMA_VERSION,
		cardsByNoteId: {},
		noteIdsByFile: {},
		deletedFilePaths: [],
		pendingDeleteNoteIds: [],
		pendingSyncFilePaths: [],
		lastSyncAt: null,
		lastScanConfigHash: null,
		lastFullReconcileAt: null,
	};
}

export class IndexStore {
	private index: PluginIndex;

	constructor(snapshot?: PluginIndex) {
		this.index = loadPluginIndex(snapshot);
	}

	getSnapshot(): PluginIndex {
		return clonePluginIndex(this.index);
	}

	getDeletedFilePaths(): string[] {
		return [...this.index.deletedFilePaths];
	}

	getPendingDeleteNoteIds(): string[] {
		return [...this.index.pendingDeleteNoteIds];
	}

	getPendingSyncFilePaths(): string[] {
		return [...this.index.pendingSyncFilePaths];
	}

	markFileDeleted(filePath: string): boolean {
		const trackedNoteIds = this.index.noteIdsByFile[filePath];
		if (!trackedNoteIds || trackedNoteIds.length === 0) {
			return false;
		}

		if (!this.index.deletedFilePaths.includes(filePath)) {
			this.index.deletedFilePaths.push(filePath);
			return true;
		}

		return false;
	}

	markFilePendingSync(filePath: string): void {
		if (!this.index.pendingSyncFilePaths.includes(filePath)) {
			this.index.pendingSyncFilePaths.push(filePath);
		}
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
		this.index.deletedFilePaths = this.index.deletedFilePaths.filter(
			(path) => path !== filePath,
		);
	}

	clearFilePendingSync(filePath: string): void {
		this.index.pendingSyncFilePaths = this.index.pendingSyncFilePaths.filter(
			(path) => path !== filePath,
		);
	}

	removeFileTracking(filePath: string): void {
		delete this.index.noteIdsByFile[filePath];
		this.clearDeletedFile(filePath);
		this.clearFilePendingSync(filePath);
		this.pruneDeletedFilePaths();
	}

	replace(index: PluginIndex): void {
		this.index = clonePluginIndex(index);
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
		const noteIds = this.index.noteIdsByFile[oldPath];
		if (noteIds) {
			delete this.index.noteIdsByFile[oldPath];
			this.index.noteIdsByFile[newPath] = [...noteIds];

			for (const noteId of noteIds) {
				const record = this.index.cardsByNoteId[noteId];
				if (record) {
					record.filePath = newPath;
				}
			}
		}

		if (this.index.deletedFilePaths.includes(oldPath)) {
			this.index.deletedFilePaths = this.index.deletedFilePaths.map((filePath) =>
				filePath === oldPath ? newPath : filePath,
			);
		}

		if (this.index.pendingSyncFilePaths.includes(oldPath)) {
			this.index.pendingSyncFilePaths = this.index.pendingSyncFilePaths.map((filePath) =>
				filePath === oldPath ? newPath : filePath,
			);
		}

		this.clearDeletedFile(newPath);
	}

	removeCardsByNoteIds(noteIds: string[]): void {
		if (noteIds.length === 0) {
			return;
		}

		const noteIdSet = new Set(noteIds);

		for (const noteId of noteIdSet) {
			delete this.index.cardsByNoteId[noteId];
		}

		for (const [filePath, fileNoteIds] of Object.entries(this.index.noteIdsByFile)) {
			const remainingNoteIds = fileNoteIds.filter((noteId) => !noteIdSet.has(noteId));
			if (remainingNoteIds.length > 0) {
				this.index.noteIdsByFile[filePath] = remainingNoteIds;
			} else {
				delete this.index.noteIdsByFile[filePath];
			}
		}

		this.index.pendingDeleteNoteIds = this.index.pendingDeleteNoteIds.filter(
			(noteId) => !noteIdSet.has(noteId),
		);
		this.pruneDeletedFilePaths();
	}

	setFileCards(
		filePath: string,
		cards: ParsedCard[],
		options: { preserveUnseen?: boolean } = {},
	): void {
		const preserveUnseen = options.preserveUnseen ?? false;
		const existingNoteIds = new Set(this.index.noteIdsByFile[filePath] ?? []);
		const nextNoteIds: string[] = [];
		const now = Date.now();

		for (const card of cards) {
			if (!card.noteId) {
				continue;
			}

			nextNoteIds.push(card.noteId);
			const existingRecord = this.index.cardsByNoteId[card.noteId];
			if (existingRecord && existingRecord.filePath !== filePath) {
				const previousFileNoteIds = this.index.noteIdsByFile[existingRecord.filePath];
				if (previousFileNoteIds) {
					const remainingNoteIds = previousFileNoteIds.filter(
						(noteId) => noteId !== card.noteId,
					);
					if (remainingNoteIds.length > 0) {
						this.index.noteIdsByFile[existingRecord.filePath] = remainingNoteIds;
					} else {
						delete this.index.noteIdsByFile[existingRecord.filePath];
					}
				}
			}

			this.index.cardsByNoteId[card.noteId] = {
				noteId: card.noteId,
				filePath,
				lastSeenAt: now,
			};
		}

		if (!preserveUnseen) {
			for (const noteId of existingNoteIds) {
				if (!nextNoteIds.includes(noteId)) {
					delete this.index.cardsByNoteId[noteId];
				}
			}
		}

		const mergedNoteIds = preserveUnseen
			? Array.from(new Set([...(this.index.noteIdsByFile[filePath] ?? []), ...nextNoteIds]))
			: nextNoteIds;

		if (mergedNoteIds.length > 0) {
			this.index.noteIdsByFile[filePath] = mergedNoteIds;
		} else {
			delete this.index.noteIdsByFile[filePath];
		}

		this.clearDeletedFile(filePath);
		this.pruneDeletedFilePaths();
	}

	private pruneDeletedFilePaths(): void {
		this.index.deletedFilePaths = this.index.deletedFilePaths.filter(
			(filePath) => Boolean(this.index.noteIdsByFile[filePath]),
		);
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
		cardsByNoteId: { ...index.cardsByNoteId },
		noteIdsByFile: cloneFileMap(index.noteIdsByFile),
		deletedFilePaths: [...index.deletedFilePaths],
		pendingDeleteNoteIds: [...index.pendingDeleteNoteIds],
		pendingSyncFilePaths: [...index.pendingSyncFilePaths],
		lastSyncAt: index.lastSyncAt,
		lastScanConfigHash: index.lastScanConfigHash,
		lastFullReconcileAt: index.lastFullReconcileAt,
	};
}

function cloneFileMap(fileMap: Record<string, string[]>): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(fileMap).map(([filePath, noteIds]) => [filePath, [...noteIds]]),
	);
}

function isPluginIndex(value: unknown): value is PluginIndex {
	return (
		isRecord(value) &&
		typeof value.schemaVersion === "number" &&
		isCardIndexRecordMap(value.cardsByNoteId) &&
		isStringArrayMap(value.noteIdsByFile) &&
		isStringArray(value.deletedFilePaths) &&
		isStringArray(value.pendingDeleteNoteIds) &&
		isStringArray(value.pendingSyncFilePaths) &&
		isNullableNumber(value.lastSyncAt) &&
		isNullableString(value.lastScanConfigHash) &&
		isNullableNumber(value.lastFullReconcileAt)
	);
}

function isCardIndexRecordMap(value: unknown): value is PluginIndex["cardsByNoteId"] {
	return isRecord(value) && Object.values(value).every(isCardIndexRecord);
}

function isCardIndexRecord(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.noteId === "string" &&
		typeof value.filePath === "string" &&
		typeof value.lastSeenAt === "number"
	);
}

function isStringArrayMap(value: unknown): value is Record<string, string[]> {
	return isRecord(value) && Object.values(value).every(isStringArray);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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
