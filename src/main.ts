import { Plugin } from "obsidian";
import { registerCommands } from "./commands";
import { IndexStore } from "./index-store";
import { logVerbose } from "./logger";
import { registerObsidianEventHandlers } from "./obsidian-events";
import {
	DEFAULT_SETTINGS,
	ObakSettingTab,
	loadSettings,
	type ObakSettings,
} from "./settings";
import { reconcileMissingFiles } from "./sync-runner";
import type { StoredPluginData } from "./types";

export default class ObakPlugin extends Plugin {
	settings: ObakSettings = DEFAULT_SETTINGS;
	indexStore = new IndexStore();
	private dirtyFilePaths = new Set<string>();
	private startupReconcileCompleted = false;
	private startupReconcileInFlight = false;
	private startupReconcileRetryPending = false;
	private internalWriteStateByPath = new Map<
		string,
		{ count: number; expiry: number }
	>();

	async onload(): Promise<void> {
		const data = (await this.loadData()) as StoredPluginData | null;
		this.settings = loadSettings(data?.settings);
		this.indexStore = new IndexStore(data?.index);
		const snapshot = this.indexStore.getSnapshot();

		logVerbose(this, "Loaded plugin state.", {
			trackedFiles: Object.keys(snapshot.uidsByFile).length,
			trackedCards: Object.keys(snapshot.cardsByUid).length,
			pendingDeletes: snapshot.pendingDeleteNoteIds.length,
		});

		this.addSettingTab(new ObakSettingTab(this.app, this));
		registerCommands(this);
		registerObsidianEventHandlers(this);

		if (this.settings.reconcileOnStartup) {
			this.registerEvent(
				this.app.metadataCache.on("resolved", () => {
					if (
						!this.startupReconcileRetryPending ||
						this.startupReconcileCompleted ||
						this.startupReconcileInFlight
					) {
						return;
					}

					this.startupReconcileRetryPending = false;
					void this.runStartupReconcile("metadata-cache-resolved");
				}),
			);

			this.app.workspace.onLayoutReady(() => {
				void this.runStartupReconcile("layout-ready");
			});
		}
	}

	private async runStartupReconcile(
		trigger: "layout-ready" | "metadata-cache-resolved",
	): Promise<void> {
		if (this.startupReconcileCompleted || this.startupReconcileInFlight) {
			return;
		}

		this.startupReconcileInFlight = true;
		logVerbose(this, "Running startup reconcile for missing files.", { trigger });

		try {
			const result = await reconcileMissingFiles(this);
			if (result.deferred) {
				this.startupReconcileRetryPending = true;
				logVerbose(
					this,
					"Deferred startup reconcile until metadata cache finishes resolving files.",
					{ trigger },
				);
				return;
			}

			this.startupReconcileCompleted = true;
			this.startupReconcileRetryPending = false;
			logVerbose(this, "Startup reconcile finished.", result);
		} finally {
			this.startupReconcileInFlight = false;
		}
	}

	async savePluginData(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			index: this.indexStore.getSnapshot(),
		});
	}

	markFileDirty(filePath: string): void {
		this.dirtyFilePaths.add(filePath);
	}

	clearFileDirty(filePath: string): void {
		this.dirtyFilePaths.delete(filePath);
	}

	clearFilesDirty(filePaths: Iterable<string>): void {
		for (const filePath of filePaths) {
			this.dirtyFilePaths.delete(filePath);
		}
	}

	getDirtyFilePaths(): string[] {
		return [...this.dirtyFilePaths];
	}

	registerInternalFileWrite(filePath: string): void {
		const existing = this.internalWriteStateByPath.get(filePath);
		this.internalWriteStateByPath.set(filePath, {
			count: (existing?.count ?? 0) + 1,
			expiry: Date.now() + 5000,
		});
	}

	consumeInternalFileWrite(filePath: string): boolean {
		const state = this.internalWriteStateByPath.get(filePath);
		if (!state) {
			return false;
		}

		if (state.expiry < Date.now()) {
			this.internalWriteStateByPath.delete(filePath);
			return false;
		}

		if (state.count <= 1) {
			this.internalWriteStateByPath.delete(filePath);
		} else {
			this.internalWriteStateByPath.set(filePath, {
				count: state.count - 1,
				expiry: state.expiry,
			});
		}

		return true;
	}
}
