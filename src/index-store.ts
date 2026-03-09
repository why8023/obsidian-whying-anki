import type { FileIndexRecord, ParsedCard, PluginIndex } from "./types";

const INDEX_SCHEMA_VERSION = 2;

export function createEmptyPluginIndex(): PluginIndex {
	return {
		schemaVersion: INDEX_SCHEMA_VERSION,
		cardsByUid: {},
		uidsByFile: {},
		filesByPath: {},
		pendingDeleteNoteIds: [],
		lastFullReconcileAt: null,
	};
}

export class IndexStore {
	private index: PluginIndex;

	constructor(snapshot?: Partial<PluginIndex>) {
		this.index = normalizePluginIndex(snapshot);
	}

	getSnapshot(): PluginIndex {
		return clonePluginIndex(this.index);
	}

	getPendingDeleteNoteIds(): string[] {
		return [...this.index.pendingDeleteNoteIds];
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

	invalidateFileState(filePath: string): void {
		const existing = this.index.filesByPath[filePath];
		if (!existing) {
			return;
		}

		this.index.filesByPath[filePath] = {
			...existing,
			lastIndexedMtime: null,
			lastIndexedSize: null,
			lastScanConfigHash: null,
		};
	}

	removeFileState(filePath: string): void {
		delete this.index.filesByPath[filePath];
	}

	replace(index: PluginIndex): void {
		this.index = clonePluginIndex(index);
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

		const fileState = this.index.filesByPath[oldPath];
		if (fileState) {
			delete this.index.filesByPath[oldPath];
			this.index.filesByPath[newPath] = {
				...fileState,
				lastIndexedMtime: null,
				lastIndexedSize: null,
				lastScanConfigHash: null,
			};
		}
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
	}

	setFileState(filePath: string, record: FileIndexRecord): void {
		this.index.filesByPath[filePath] = { ...record };
	}
}

function normalizePluginIndex(snapshot?: Partial<PluginIndex>): PluginIndex {
	const index = createEmptyPluginIndex();

	return {
		schemaVersion:
			typeof snapshot?.schemaVersion === "number"
				? snapshot.schemaVersion
				: index.schemaVersion,
		cardsByUid: snapshot?.cardsByUid ? { ...snapshot.cardsByUid } : {},
		uidsByFile: snapshot?.uidsByFile ? cloneFileMap(snapshot.uidsByFile) : {},
		filesByPath: snapshot?.filesByPath ? cloneFileStateMap(snapshot.filesByPath) : {},
		pendingDeleteNoteIds: Array.isArray(snapshot?.pendingDeleteNoteIds)
			? [...new Set(snapshot.pendingDeleteNoteIds.filter(isString))]
			: [],
		lastFullReconcileAt:
			typeof snapshot?.lastFullReconcileAt === "number"
				? snapshot.lastFullReconcileAt
				: null,
	};
}

function clonePluginIndex(index: PluginIndex): PluginIndex {
	return {
		schemaVersion: index.schemaVersion,
		cardsByUid: { ...index.cardsByUid },
		uidsByFile: cloneFileMap(index.uidsByFile),
		filesByPath: cloneFileStateMap(index.filesByPath),
		pendingDeleteNoteIds: [...index.pendingDeleteNoteIds],
		lastFullReconcileAt: index.lastFullReconcileAt,
	};
}

function cloneFileMap(fileMap: Record<string, string[]>): Record<string, string[]> {
	return Object.fromEntries(
		Object.entries(fileMap).map(([filePath, uids]) => [filePath, [...uids]]),
	);
}

function cloneFileStateMap(
	fileMap: Record<string, FileIndexRecord>,
): Record<string, FileIndexRecord> {
	return Object.fromEntries(
		Object.entries(fileMap).map(([filePath, record]) => [filePath, { ...record }]),
	);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}
