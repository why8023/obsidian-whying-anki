import { Plugin, TFile } from "obsidian";
import type { WhyingAnkiPluginApi } from "./types";

export function registerObsidianEventHandlers(
	plugin: Plugin & WhyingAnkiPluginApi,
): void {
	plugin.app.workspace.onLayoutReady(() => {
		plugin.registerEvent(
			plugin.app.vault.on("create", (file) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				plugin.markFileDirty(file.path);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("modify", (file) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				if (plugin.consumeInternalFileWrite(file.path)) {
					return;
				}

				plugin.markFileDirty(file.path);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("delete", (file) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				if (plugin.indexStore.markFileDeleted(file.path)) {
					void plugin.savePluginData();
				}

				plugin.clearFileDirty(file.path);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("rename", (file, oldPath) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				plugin.clearFileDirty(oldPath);
				plugin.indexStore.renameFile(oldPath, file.path);
				plugin.markFileDirty(file.path);
				void plugin.savePluginData();
			}),
		);
	});
}

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}
