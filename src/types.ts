import type { App, TFile } from "obsidian";
import type { ObakSettings } from "./settings";

export interface CardStartMeta {
	deck?: string;
	tags: string[];
}

export interface CardEndMeta {
	uid: string | null;
	noteId: string | null;
	rev: string | null;
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
	uid: string | null;
	noteId: string | null;
	rev: string | null;
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
	uid: string;
	filePath: string;
	ankiNoteId: string | null;
	lastSyncedRev: string | null;
	lastSeenAt: number;
}

export interface PluginIndex {
	schemaVersion: number;
	cardsByUid: Record<string, CardIndexRecord>;
	uidsByFile: Record<string, string[]>;
	deletedFilePaths: string[];
	pendingDeleteNoteIds: string[];
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
