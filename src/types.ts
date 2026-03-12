import type { App, TFile } from "obsidian";
import type { ObakSettings } from "./settings";

export interface CardStartMeta {
	deck?: string;
	tags: string[];
}

export interface CardEndMeta {
	noteId: string | null;
}

export interface ParseError {
	filePath: string;
	line: number;
	message: string;
}

export interface ParsedCardBlock {
	filePath: string;
	startLine: number;
	backLine: number;
	endLine: number;
	endMarkerStartOffset: number;
	endMarkerEndOffset: number;
	originalEndMarker: string;
	frontRaw: string;
	backRaw: string;
	startMeta: CardStartMeta;
	endMeta: CardEndMeta;
}

export interface ParsedCard extends ParsedCardBlock {
	noteId: string | null;
	fileMtime: number;
	frontNormalized: string;
	backNormalized: string;
	effectiveDeck: string;
	effectiveTags: string[];
	obUri: string;
}

export interface FileDefaults {
	deck?: string;
	tags: string[];
}

export interface ScannedFile {
	file: TFile;
	text: string;
	newline: "\n" | "\r\n";
	cards: ParsedCard[];
	errors: ParseError[];
}

export interface CardIndexRecord {
	noteId: string;
	filePath: string;
	lastSeenAt: number;
}

export interface PluginIndex {
	schemaVersion: number;
	cardsByNoteId: Record<string, CardIndexRecord>;
	noteIdsByFile: Record<string, string[]>;
	deletedFilePaths: string[];
	pendingDeleteNoteIds: string[];
	pendingSyncFilePaths: string[];
	lastSyncAt: number | null;
	lastScanConfigHash: string | null;
	lastFullReconcileAt: number | null;
}

export interface StoredPluginData {
	settings?: ObakSettings;
	index?: PluginIndex;
}

export interface IndexStoreApi {
	getSnapshot(): PluginIndex;
	getDeletedFilePaths(): string[];
	getPendingDeleteNoteIds(): string[];
	getPendingSyncFilePaths(): string[];
	markFileDeleted(filePath: string): boolean;
	markFilePendingSync(filePath: string): void;
	queuePendingDelete(noteIds: string[]): void;
	dequeuePendingDelete(noteIds: string[]): void;
	clearDeletedFile(filePath: string): void;
	clearFilePendingSync(filePath: string): void;
	removeFileTracking(filePath: string): void;
	removeCardsByNoteIds(noteIds: string[]): void;
	renameFile(oldPath: string, newPath: string): void;
	setFileCards(filePath: string, cards: ParsedCard[], options?: { preserveUnseen?: boolean }): void;
	setLastScanConfigHash(signature: string | null): void;
	setLastSyncAt(timestamp: number | null): void;
	setLastFullReconcileAt(timestamp: number | null): void;
	replace(index: PluginIndex): void;
}

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

export interface LocalRefreshResult {
	filesProcessed: number;
	filesRewritten: number;
	cardsProcessed: number;
	parseErrors: ParseError[];
	runtimeErrors: string[];
}

export interface SyncToAnkiResult extends LocalRefreshResult {
	cardsDeleted: number;
	cardsCreated: number;
	cardsUpdated: number;
	cardsUnchanged: number;
}

export interface SyncProgressUpdate {
	message: string;
	completed: number;
	total: number | null;
}

export interface SyncExecutionOptions {
	onProgress?: (update: SyncProgressUpdate) => void;
}
