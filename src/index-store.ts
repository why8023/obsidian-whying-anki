import type { ParsedCard, PluginIndex } from "./types";

const INDEX_SCHEMA_VERSION = 3;

export function createEmptyPluginIndex(): PluginIndex {
	return {
		schemaVersion: INDEX_SCHEMA_VERSION,
		cardsByUid: {},
		uidsByFile: {},
		deletedFilePaths: [],
		pendingDeleteNoteIds: [],
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

	markFileDeleted(filePath: string): boolean {
		const trackedUids = this.index.uidsByFile[filePath];
		if (!trackedUids || trackedUids.length === 0) {
			return false;
		}

		if (!this.index.deletedFilePaths.includes(filePath)) {
			this.index.deletedFilePaths.push(filePath);
			return true;
		}

		return false;
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

	removeFileTracking(filePath: string): void {
		delete this.index.uidsByFile[filePath];
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
		const uids = this.index.uidsByFile[oldPath];
		if (uids) {
			delete this.index.uidsByFile[oldPath];
			this.index.uidsByFile[newPath] = [...uids];

			for (const uid of uids) {
				const record = this.index.cardsByUid[uid];
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

		this.clearDeletedFile(newPath);
	}

	removeCardsByNoteIds(noteIds: string[]): void {
		if (noteIds.length === 0) {
			return;
		}

		const noteIdSet = new Set(noteIds);
		const uidsToRemove = Object.values(this.index.cardsByUid)
			.filter((record) => record.ankiNoteId && noteIdSet.has(record.ankiNoteId))
			.map((record) => record.uid);

		this.removeCardsByUids(uidsToRemove);
		this.index.pendingDeleteNoteIds = this.index.pendingDeleteNoteIds.filter(
			(noteId) => !noteIdSet.has(noteId),
		);
	}

	removeCardsByUids(uids: string[]): void {
		if (uids.length === 0) {
			return;
		}

		const uidSet = new Set(uids);

		for (const uid of uidSet) {
			delete this.index.cardsByUid[uid];
		}

		for (const [filePath, fileUids] of Object.entries(this.index.uidsByFile)) {
			const remainingUids = fileUids.filter((uid) => !uidSet.has(uid));
			if (remainingUids.length > 0) {
				this.index.uidsByFile[filePath] = remainingUids;
			} else {
				delete this.index.uidsByFile[filePath];
			}
		}

		this.pruneDeletedFilePaths();
	}

	setFileCards(
		filePath: string,
		cards: ParsedCard[],
		options: { preserveUnseen?: boolean; preserveSyncedRev?: boolean } = {},
	): void {
		const preserveUnseen = options.preserveUnseen ?? false;
		const preserveSyncedRev = options.preserveSyncedRev ?? false;
		const existingUids = new Set(this.index.uidsByFile[filePath] ?? []);
		const nextUids: string[] = [];
		const now = Date.now();

		for (const card of cards) {
			if (!card.uid) {
				continue;
			}

			nextUids.push(card.uid);
			const existingRecord = this.index.cardsByUid[card.uid];
			if (existingRecord && existingRecord.filePath !== filePath) {
				const previousFileUids = this.index.uidsByFile[existingRecord.filePath];
				if (previousFileUids) {
					const remainingUids = previousFileUids.filter((uid) => uid !== card.uid);
					if (remainingUids.length > 0) {
						this.index.uidsByFile[existingRecord.filePath] = remainingUids;
					} else {
						delete this.index.uidsByFile[existingRecord.filePath];
					}
				}
			}

			this.index.cardsByUid[card.uid] = {
				uid: card.uid,
				filePath,
				ankiNoteId: card.noteId,
				lastSyncedRev: preserveSyncedRev
					? existingRecord?.lastSyncedRev ?? (card.noteId ? card.rev : null)
					: card.rev,
				lastSeenAt: now,
			};
		}

		if (!preserveUnseen) {
			for (const uid of existingUids) {
				if (!nextUids.includes(uid)) {
					delete this.index.cardsByUid[uid];
				}
			}
		}

		const mergedUids = preserveUnseen
			? Array.from(new Set([...(this.index.uidsByFile[filePath] ?? []), ...nextUids]))
			: nextUids;

		if (mergedUids.length > 0) {
			this.index.uidsByFile[filePath] = mergedUids;
		} else {
			delete this.index.uidsByFile[filePath];
		}

		this.clearDeletedFile(filePath);
		this.pruneDeletedFilePaths();
	}

	private pruneDeletedFilePaths(): void {
		this.index.deletedFilePaths = this.index.deletedFilePaths.filter(
			(filePath) => Boolean(this.index.uidsByFile[filePath]),
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
		cardsByUid: { ...index.cardsByUid },
		uidsByFile: cloneFileMap(index.uidsByFile),
		deletedFilePaths: [...index.deletedFilePaths],
		pendingDeleteNoteIds: [...index.pendingDeleteNoteIds],
		lastSyncAt: index.lastSyncAt,
		lastScanConfigHash: index.lastScanConfigHash,
		lastFullReconcileAt: index.lastFullReconcileAt,
	};
}

function cloneFileMap(fileMap: Record<string, string[]>): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(fileMap).map(([filePath, uids]) => [filePath, [...uids]]),
	);
}

function isPluginIndex(value: unknown): value is PluginIndex {
	return (
		isRecord(value) &&
		typeof value.schemaVersion === "number" &&
		isCardIndexRecordMap(value.cardsByUid) &&
		isStringArrayMap(value.uidsByFile) &&
		isStringArray(value.deletedFilePaths) &&
		isStringArray(value.pendingDeleteNoteIds) &&
		isNullableNumber(value.lastSyncAt) &&
		isNullableString(value.lastScanConfigHash) &&
		isNullableNumber(value.lastFullReconcileAt)
	);
}

function isCardIndexRecordMap(value: unknown): value is PluginIndex["cardsByUid"] {
	return isRecord(value) && Object.values(value).every(isCardIndexRecord);
}

function isCardIndexRecord(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.uid === "string" &&
		typeof value.filePath === "string" &&
		isNullableString(value.ankiNoteId) &&
		isNullableString(value.lastSyncedRev) &&
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
