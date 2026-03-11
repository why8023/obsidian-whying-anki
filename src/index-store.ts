import type { ParsedCard, PluginIndex } from "./types";

// 每次持久化结构发生兼容性变化时都要递增，旧版本索引会被安全丢弃并重建。
const INDEX_SCHEMA_VERSION = 3;

/**
 * 创建一个全新的空索引。
 */
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

/**
 * 插件索引的内存封装层。
 * 它负责所有“如何增删改查卡片追踪状态”的细节，并保证外部拿到的是快照而不是内部引用。
 */
export class IndexStore {
	private index: PluginIndex;

	constructor(snapshot?: PluginIndex) {
		this.index = loadPluginIndex(snapshot);
	}

	/**
	 * 返回当前索引的深拷贝快照，防止调用方意外修改内部状态。
	 */
	getSnapshot(): PluginIndex {
		return clonePluginIndex(this.index);
	}

	getDeletedFilePaths(): string[] {
		return [...this.index.deletedFilePaths];
	}

	getPendingDeleteNoteIds(): string[] {
		return [...this.index.pendingDeleteNoteIds];
	}

	/**
	 * 把文件标记为“已删除待处理”。
	 * 只有这个文件原先确实被索引追踪时才返回 `true`。
	 */
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

	/**
	 * 把待删除 noteId 放入队列，供下一次同步时批量删除 Anki 笔记。
	 */
	queuePendingDelete(noteIds: string[]): void {
		for (const noteId of noteIds) {
			if (!this.index.pendingDeleteNoteIds.includes(noteId)) {
				this.index.pendingDeleteNoteIds.push(noteId);
			}
		}
	}

	/**
	 * 从待删队列中移除已经处理完或不再需要删除的 noteId。
	 */
	dequeuePendingDelete(noteIds: string[]): void {
		if (noteIds.length === 0) {
			return;
		}

		const noteIdSet = new Set(noteIds);
		this.index.pendingDeleteNoteIds = this.index.pendingDeleteNoteIds.filter(
			(noteId) => !noteIdSet.has(noteId),
		);
	}

	/**
	 * 清除某个文件的“已删除待处理”标记。
	 */
	clearDeletedFile(filePath: string): void {
		this.index.deletedFilePaths = this.index.deletedFilePaths.filter(
			(path) => path !== filePath,
		);
	}

	/**
	 * 移除某个文件到 UID 列表的映射。
	 * 注意：这里只删文件索引，不负责逐个删卡；调用方需要先决定卡片如何处理。
	 */
	removeFileTracking(filePath: string): void {
		delete this.index.uidsByFile[filePath];
		this.pruneDeletedFilePaths();
	}

	/**
	 * 用新的完整索引替换当前状态。
	 * 一般用于重建索引后整体覆盖。
	 */
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

	/**
	 * 处理文件重命名。
	 * 除了更新 `uidsByFile`，还会同步修正每张卡片记录里的 `filePath`。
	 */
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

	/**
	 * 按 noteId 删除卡片记录，主要用于 Anki 侧删除成功后的回收。
	 */
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

	/**
	 * 按 UID 删除卡片记录，同时清理各文件里的 UID 列表。
	 */
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

	/**
	 * 用扫描结果更新某个文件包含的卡片。
	 *
	 * `preserveUnseen`:
	 * 表示即便这次扫描没看到旧卡，也暂时不要把它从索引里删掉。
	 * 常用于“文件写回失败”或“删除阶段未完成”这类不能完全确认最终状态的场景。
	 *
	 * `preserveSyncedRev`:
	 * 表示保留索引里记录的上次已同步 rev，避免本地刷新元数据时把“是否已同步”的判断覆盖掉。
	 */
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
				// 同一个 UID 迁移到别的文件时，先把旧文件里的引用移除。
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
					? existingRecord?.lastSyncedRev ?? null
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
		// 只保留那些当前仍然有索引痕迹的“已删除文件”，避免悬挂路径越积越多。
		this.index.deletedFilePaths = this.index.deletedFilePaths.filter(
			(filePath) => Boolean(this.index.uidsByFile[filePath]),
		);
	}
}

function loadPluginIndex(snapshot?: unknown): PluginIndex {
	// 只接受结构合法且 schemaVersion 匹配的快照；否则直接从空索引开始。
	if (!isPluginIndex(snapshot) || snapshot.schemaVersion !== INDEX_SCHEMA_VERSION) {
		return createEmptyPluginIndex();
	}

	return clonePluginIndex(snapshot);
}

function clonePluginIndex(index: PluginIndex): PluginIndex {
	// 浅拷贝对象不够，因为 `uidsByFile` 里还嵌套数组，需要继续复制一层。
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
	// 持久化数据来自磁盘，读取时必须做严格守卫，避免旧格式或损坏数据污染运行时状态。
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
