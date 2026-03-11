import type { App, TFile } from "obsidian";
import type { ObakSettings } from "./settings";

/**
 * `card-start` 标记上允许携带的元信息。
 * 这些信息只在扫描阶段存在，后续会与文件级/全局默认值合并。
 */
export interface CardStartMeta {
	deck?: string;
	tags: string[];
}

/**
 * `card-end` 标记上持久化的同步元信息。
 * 这些字段会被插件回写到 Markdown 文件里，作为下一次同步的锚点。
 */
export interface CardEndMeta {
	uid: string | null;
	noteId: string | null;
	rev: string | null;
}

/**
 * Markdown 语法解析错误。
 * 这里只描述“文件中写法不合法”的问题，不包含运行时或网络错误。
 */
export interface ParseError {
	filePath: string;
	line: number;
	message: string;
}

/**
 * 直接从 Markdown 标记语法中解析出来的原始卡片块。
 * 此时还没有补齐 UID、deck/tags 继承、Anki 渲染结果等派生字段。
 */
export interface ParsedCardBlock {
	filePath: string;
	// `card-start` 所在行号。
	startLine: number;
	// `card-back` 所在行号。
	backLine: number;
	// `card-end` 所在行号。
	endLine: number;
	// 结束标记在原始文件文本中的起止偏移，用于原地重写 `card-end`。
	endMarkerStartOffset: number;
	endMarkerEndOffset: number;
	// 原始结束标记文本，用来判断是否真的需要回写。
	originalEndMarker: string;
	// 正反面保留原始 Markdown 文本，后续再统一归一化和渲染。
	frontRaw: string;
	backRaw: string;
	startMeta: CardStartMeta;
	endMeta: CardEndMeta;
}

/**
 * 已补齐同步上下文的完整卡片对象。
 * 这是扫描和同步阶段最常使用的核心数据结构。
 */
export interface ParsedCard extends ParsedCardBlock {
	// 插件内部稳定标识，优先映射到 Anki 中的同一条笔记。
	uid: string | null;
	// 已同步到 Anki 后的 noteId；新卡创建前可能为空。
	noteId: string | null;
	// 基于卡片内容计算出的修订签名，用于判断是否需要更新 Anki。
	rev: string | null;
	// 读取文件时的最后修改时间，用于后续增量同步判断。
	fileMtime: number;
	// 发送给 Anki 之前的标准化 HTML 内容。
	frontNormalized: string;
	backNormalized: string;
	// 结合卡片级、文件级和全局默认值后得到的实际 deck/tags。
	effectiveDeck: string;
	effectiveTags: string[];
	// 回链到 Obsidian 原文件的 URI。
	obUri: string;
}

/**
 * 文件级 frontmatter 默认值。
 * 这些默认值会被应用到当前文件里的每张卡。
 */
export interface FileDefaults {
	deck?: string;
	tags: string[];
}

/**
 * 扫描单个 Markdown 文件的结果。
 */
export interface ScannedFile {
	file: TFile;
	// 原始文件全文；后续回写时会做一致性校验，防止覆盖用户新改动。
	text: string;
	// 保留原文件换行风格，重写结束标记时尽量不破坏文件格式。
	newline: "\n" | "\r\n";
	cards: ParsedCard[];
	errors: ParseError[];
}

/**
 * 索引中记录的单张卡片同步状态。
 * 这是插件跨会话追踪“Obsidian 卡片 <-> Anki note”关系的关键。
 */
export interface CardIndexRecord {
	uid: string;
	filePath: string;
	ankiNoteId: string | null;
	// 上一次成功同步到 Anki 的修订签名；用来跳过未变化卡片。
	lastSyncedRev: string | null;
	// 最近一次在 vault 中看到这张卡片的时间戳。
	lastSeenAt: number;
}

/**
 * 插件持久化索引。
 * 该对象会完整写入 `data.json`，用于跨重启恢复同步状态。
 */
export interface PluginIndex {
	schemaVersion: number;
	// 通过 UID 定位卡片，是最主要的查询入口。
	cardsByUid: Record<string, CardIndexRecord>;
	// 按文件反查其包含的 UID 列表，方便处理文件删除/重命名。
	uidsByFile: Record<string, string[]>;
	// 已在 vault 中消失、但尚未彻底处理完的文件路径。
	deletedFilePaths: string[];
	// 需要在下一次同步时删除的 Anki noteId 队列。
	pendingDeleteNoteIds: string[];
	// 上次同步时间与扫描配置签名，用来支持增量同步。
	lastSyncAt: number | null;
	lastScanConfigHash: string | null;
	// 上一次“全库缺失文件对账”完成的时间。
	lastFullReconcileAt: number | null;
}

/**
 * 插件整体持久化结构，对应 Obsidian `loadData/saveData` 的内容。
 */
export interface StoredPluginData {
	settings?: ObakSettings;
	index?: PluginIndex;
}

/**
 * 索引存储层暴露给其他模块的 API。
 * 这样同步器不依赖具体实现细节，只依赖可替换的行为。
 */
export interface IndexStoreApi {
	getSnapshot(): PluginIndex;
	getDeletedFilePaths(): string[];
	getPendingDeleteNoteIds(): string[];
	markFileDeleted(filePath: string): boolean;
	queuePendingDelete(noteIds: string[]): void;
	dequeuePendingDelete(noteIds: string[]): void;
	clearDeletedFile(filePath: string): void;
	removeFileTracking(filePath: string): void;
	removeCardsByNoteIds(noteIds: string[]): void;
	removeCardsByUids(uids: string[]): void;
	renameFile(oldPath: string, newPath: string): void;
	setFileCards(
		filePath: string,
		cards: ParsedCard[],
		options?: { preserveUnseen?: boolean; preserveSyncedRev?: boolean },
	): void;
	setLastScanConfigHash(signature: string | null): void;
	setLastSyncAt(timestamp: number | null): void;
	setLastFullReconcileAt(timestamp: number | null): void;
	replace(index: PluginIndex): void;
}

/**
 * 主插件实例对外暴露的能力集合。
 * 各子模块会依赖这组最小接口，而不是直接依赖完整的 `ObakPlugin` 类。
 */
export interface ObakPluginApi {
	app: App;
	settings: ObakSettings;
	indexStore: IndexStoreApi;
	clearFileDirty(filePath: string): void;
	clearFilesDirty(filePaths: Iterable<string>): void;
	consumeInternalFileWrite(filePath: string): boolean;
	getDirtyFilePaths(): string[];
	markFileDirty(filePath: string): void;
	registerInternalFileWrite(filePath: string): void;
	runExclusiveSync<T>(label: string, task: () => Promise<T>): Promise<T | null>;
	savePluginData(): Promise<void>;
}

/**
 * 本地刷新结果。
 * 只关心扫描、重写和索引刷新，不包含与 Anki 的实际同步统计。
 */
export interface LocalRefreshResult {
	filesProcessed: number;
	filesRewritten: number;
	cardsProcessed: number;
	parseErrors: ParseError[];
	runtimeErrors: string[];
}

/**
 * 完整同步结果。
 * 在本地刷新统计之上，再补充 Anki 的增删改计数。
 */
export interface SyncToAnkiResult extends LocalRefreshResult {
	cardsDeleted: number;
	cardsCreated: number;
	cardsUpdated: number;
	cardsUnchanged: number;
}

/**
 * 同步进度回调的标准消息格式。
 */
export interface SyncProgressUpdate {
	message: string;
	completed: number;
	total: number | null;
}

/**
 * 执行同步时的可选参数。
 * 当前只开放进度通知回调，方便命令层接入 UI。
 */
export interface SyncExecutionOptions {
	onProgress?: (update: SyncProgressUpdate) => void;
}
