import { MarkdownView, Plugin, TFile } from "obsidian";
import type { WhyingAnkiPluginApi } from "./types";

export function registerObsidianEventHandlers(
	plugin: Plugin & WhyingAnkiPluginApi,
): void {
	plugin.registerEvent(
		plugin.app.workspace.on("editor-change", (_editor, view) => {
			if (view instanceof MarkdownView && view.file) {
				plugin.indexStore.markDirtyFile(view.file.path);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("modify", (file) => {
			if (isMarkdownFile(file)) {
				plugin.indexStore.markDirtyFile(file.path);
			}
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("rename", (file, oldPath) => {
			if (!isMarkdownFile(file)) {
				return;
			}

			plugin.indexStore.renameFile(oldPath, file.path);
			void plugin.savePluginData();
		}),
	);

	plugin.registerEvent(
		plugin.app.vault.on("delete", (file) => {
			if (!(file instanceof TFile) || file.extension !== "md") {
				return;
			}

			plugin.indexStore.queueFileDelete(file.path);
			void plugin.savePluginData();
		}),
	);

	plugin.app.workspace.onLayoutReady(() => {
		plugin.registerEvent(
			plugin.app.vault.on("create", (file) => {
				if (isMarkdownFile(file)) {
					plugin.indexStore.markDirtyFile(file.path);
				}
			}),
		);
	});
}

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}
