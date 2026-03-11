import { Plugin, TFile } from "obsidian";
import { logVerbose } from "./logger";
import type { ObakPluginApi } from "./types";

/**
 * 注册与 vault 文件变化相关的 Obsidian 事件。
 * 这些事件不会直接触发同步，而是把文件标成 dirty，等用户执行命令时再处理。
 */
export function registerObsidianEventHandlers(
	plugin: Plugin & ObakPluginApi,
): void {
	plugin.app.workspace.onLayoutReady(() => {
		// 等工作区就绪后再监听 vault，避免启动阶段状态不完整时误判。
		logVerbose(plugin, "Registering Obsidian vault event handlers.");

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

				// 插件自己重写 `card-end` 也会触发 modify；这类事件不应进入增量同步队列。
				if (plugin.consumeInternalFileWrite(file.path)) {
					logVerbose(
						plugin,
						`Ignored modify event for internal plugin rewrite: ${file.path}`,
					);
					return;
				}

				plugin.markFileDirty(file.path);
				logVerbose(plugin, `Marked modified markdown file as dirty: ${file.path}`);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("delete", (file) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				// 删除时只先登记，真正删除 Anki 笔记留到同步流程统一处理。
				if (plugin.indexStore.markFileDeleted(file.path)) {
					void plugin.savePluginData();
				}

				plugin.clearFileDirty(file.path);
				logVerbose(plugin, `Processed markdown file deletion: ${file.path}`);
			}),
		);

		plugin.registerEvent(
			plugin.app.vault.on("rename", (file, oldPath) => {
				if (!isMarkdownFile(file)) {
					return;
				}

				// 重命名要同时迁移索引里的文件路径，并把新路径标记为 dirty 以便后续重新扫描。
				plugin.clearFileDirty(oldPath);
				plugin.indexStore.renameFile(oldPath, file.path);
				plugin.markFileDirty(file.path);
				void plugin.savePluginData();
				logVerbose(plugin, `Processed markdown file rename: ${oldPath} -> ${file.path}`);
			}),
		);
	});
}

function isMarkdownFile(file: unknown): file is TFile {
	return file instanceof TFile && file.extension === "md";
}
