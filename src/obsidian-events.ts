import { Plugin, TFile } from "obsidian";
import { AutoSyncController } from "./auto-sync-controller";
import { logError, logVerbose } from "./logger";
import type { ObakPluginApi } from "./types";

/**
 * Register file-tracking and auto-sync event handlers after the workspace is ready.
 */
export function registerObsidianEventHandlers(
	plugin: Plugin & ObakPluginApi,
): void {
	const autoSyncController = new AutoSyncController(plugin);
	plugin.register(() => autoSyncController.destroy());

	plugin.app.workspace.onLayoutReady(() => {
		logVerbose(plugin, "Registering Obsidian vault event handlers.");
		autoSyncController.onActiveFileChange(plugin.app.workspace.getActiveFile());

		plugin.registerEvent(
			plugin.app.workspace.on("file-open", (file) => {
				autoSyncController.onActiveFileChange(file);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("create", (file) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				plugin.markFileDirty(file.path);
				logVerbose(plugin, `Marked new markdown file as dirty: ${file.path}`);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("modify", (file) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				if (plugin.consumeInternalFileWrite(file.path)) {
					logVerbose(
						plugin,
						`Ignored modify event for internal plugin rewrite: ${file.path}`,
					);
					return;
				}

				plugin.markFileDirty(file.path);
				autoSyncController.onMarkdownFileModify(file);
				logVerbose(plugin, `Marked modified markdown file as dirty: ${file.path}`);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("delete", (file) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				if (plugin.indexStore.markFileDeleted(file.path)) {
					void plugin.savePluginData().catch((error) => {
						logError(
							`Failed while recording deleted markdown file ${file.path}.`,
							error,
						);
					});
				}

				autoSyncController.onMarkdownFileDelete(file.path);
				plugin.clearFileDirty(file.path);
				logVerbose(plugin, `Processed markdown file deletion: ${file.path}`);
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
				autoSyncController.onMarkdownFileRename(file, oldPath);
				void plugin.savePluginData();
				logVerbose(plugin, `Processed markdown file rename: ${oldPath} -> ${file.path}`);
			}),
		);
	});
}

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}
