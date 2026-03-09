import { Plugin } from "obsidian";
import { registerCommands } from "./commands";
import { IndexStore } from "./index-store";
import { registerObsidianEventHandlers } from "./obsidian-events";
import {
	DEFAULT_SETTINGS,
	WhyingAnkiSettingTab,
	normalizeSettings,
	type WhyingAnkiSettings,
} from "./settings";
import type { StoredPluginData } from "./types";

export default class WhyingAnkiPlugin extends Plugin {
	settings: WhyingAnkiSettings = DEFAULT_SETTINGS;
	indexStore = new IndexStore();

	async onload(): Promise<void> {
		const data = (await this.loadData()) as StoredPluginData | null;
		this.settings = normalizeSettings(data?.settings);
		this.indexStore = new IndexStore(data?.index);

		this.addSettingTab(new WhyingAnkiSettingTab(this.app, this));
		registerCommands(this);
		registerObsidianEventHandlers(this);
	}

	async savePluginData(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			index: this.indexStore.getSnapshot(),
		});
	}
}
