import { Plugin } from "obsidian";
import { registerCommands } from "./commands";
import { IndexStore } from "./index-store";
import { registerObsidianEventHandlers } from "./obsidian-events";
import {
	DEFAULT_SETTINGS,
	ObakSettingTab,
	normalizeSettings,
	type ObakSettings,
} from "./settings";
import { reconcileMissingFiles } from "./sync-runner";
import type { StoredPluginData } from "./types";

export default class ObakPlugin extends Plugin {
	settings: ObakSettings = DEFAULT_SETTINGS;
	indexStore = new IndexStore();
	private dirtyFilePaths = new Set<string>();
	private internalWriteStateByPath = new Map<
		string,
		{ count: number; expiry: number }
	>();

	async onload(): Promise<void> {
		const data = (await this.loadData()) as StoredPluginData | null;
		this.settings = normalizeSettings(data?.settings);
		this.indexStore = new IndexStore(data?.index);

		this.addSettingTab(new ObakSettingTab(this.app, this));
		registerCommands(this);
		registerObsidianEventHandlers(this);

		if (this.settings.reconcileOnStartup) {
			await reconcileMissingFiles(this);
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
