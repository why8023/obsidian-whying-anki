import type { App, TFile } from "obsidian";
import type { WhyingAnkiSettings } from "./settings";

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
	pendingDeleteNoteIds: string[];
	dirtyFiles: string[];
	lastFullReconcileAt: number | null;
}

export interface StoredPluginData {
	settings?: Partial<WhyingAnkiSettings>;
	index?: Partial<PluginIndex>;
}

export interface IndexStoreApi {
	getSnapshot(): PluginIndex;
	getPendingDeleteNoteIds(): string[];
	markDirtyFile(filePath: string): void;
	clearDirtyFile(filePath: string): void;
	clearDirtyFiles(): void;
	queueFileDelete(filePath: string): void;
	renameFile(oldPath: string, newPath: string): void;
	setFileCards(
		filePath: string,
		cards: ParsedCard[],
		options?: { preserveUnseen?: boolean; preserveSyncedRev?: boolean },
	): void;
	replace(index: PluginIndex): void;
}

export interface WhyingAnkiPluginApi {
	app: App;
	settings: WhyingAnkiSettings;
	indexStore: IndexStoreApi;
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
	cardsCreated: number;
	cardsUpdated: number;
	cardsUnchanged: number;
}
