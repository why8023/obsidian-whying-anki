import { Plugin, TFile } from "obsidian";
import type { WhyingAnkiPluginApi } from "./types";

export function registerObsidianEventHandlers(
	plugin: Plugin & WhyingAnkiPluginApi,
): void {
	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (!isMarkdownFile(file)) {
				return;
			}

			plugin.indexStore.renameFile(oldPath, file.path);
			void plugin.savePluginData();
		}),
	);
}

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}
