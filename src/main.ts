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

/**
 * 插件主入口。
 * 这里只负责生命周期、状态装载、命令注册和事件绑定，真正的业务逻辑分散在其他模块里。
 */
export default class ObakPlugin extends Plugin {
	// 持久化设置；加载失败时会退回到默认值。
	settings: ObakSettings = DEFAULT_SETTINGS;
	// 卡片索引的内存封装，用来追踪 UID、文件路径和已同步的 Anki noteId。
	indexStore = new IndexStore();
	// 记录被认为“需要重新扫描/同步”的 Markdown 文件。
	private dirtyFilePaths = new Set<string>();
	// 启动时的缺失文件对账只应成功执行一次。
	private startupReconcileCompleted = false;
	// 防止启动阶段重复并发执行对账。
	private startupReconcileInFlight = false;
	// 当 Obsidian 元数据尚未准备好时，先记一个重试标记，等 resolved 事件后再跑。
	private startupReconcileRetryPending = false;
	// 插件自己重写文件时会触发 vault modify 事件，这里用短时计数避免把它当成外部改动。
	private internalWriteStateByPath = new Map<
		string,
		{ count: number; expiry: number }
	>();
	private syncInFlight = false;

	async onload(): Promise<void> {
		// data.json 中既存放设置，也存放上一次同步索引。
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
			// 某些启动阶段 vault 文件列表和 metadata cache 还没稳定，此时先挂重试逻辑。
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
		// 只允许一个启动对账流程存在，避免重复标记删除。
		if (this.startupReconcileCompleted || this.startupReconcileInFlight) {
			return;
		}

		this.startupReconcileInFlight = true;
		logVerbose(this, "Running startup reconcile for missing files.", { trigger });

		try {
			const result = await reconcileMissingFiles(this);
			if (result.deferred) {
				// 如果 vault 文件列表还没准备好，先等 metadata cache resolved 后再试一次。
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

	/**
	 * 把当前设置和索引完整写回 Obsidian 插件存储。
	 */
	async savePluginData(): Promise<void> {
		await this.saveData({
			settings: this.settings,
			index: this.indexStore.getSnapshot(),
		});
	}

	/**
	 * 标记文件为脏，表示它需要重新扫描或重新同步。
	 */
	markFileDirty(filePath: string): void {
		this.dirtyFilePaths.add(filePath);
	}

	/**
	 * 清理单个文件的脏标记；通常在本次处理成功后调用。
	 */
	clearFileDirty(filePath: string): void {
		this.dirtyFilePaths.delete(filePath);
	}

	/**
	 * 批量清理脏文件标记，避免逐个调用时的重复样板代码。
	 */
	clearFilesDirty(filePaths: Iterable<string>): void {
		for (const filePath of filePaths) {
			this.dirtyFilePaths.delete(filePath);
		}
	}

	/**
	 * 返回当前所有待处理文件路径的快照。
	 */
	getDirtyFilePaths(): string[] {
		return [...this.dirtyFilePaths];
	}

	/**
	 * 记录一次“插件内部写文件”操作。
	 * 之后 vault 的 modify 事件会消费这个计数，从而避免把内部重写误判成用户编辑。
	 */
	registerInternalFileWrite(filePath: string): void {
		const existing = this.internalWriteStateByPath.get(filePath);
		this.internalWriteStateByPath.set(filePath, {
			count: (existing?.count ?? 0) + 1,
			expiry: Date.now() + 5000,
		});
	}

	/**
	 * 尝试消费一次内部写入标记。
	 * 返回 `true` 表示这次 modify 事件来自插件自身，应被忽略。
	 */
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

	async runExclusiveSync<T>(
		label: string,
		task: () => Promise<T>,
	): Promise<T | null> {
		if (this.syncInFlight) {
			logVerbose(this, `Skipped ${label} because another sync is already running.`);
			return null;
		}

		this.syncInFlight = true;
		logVerbose(this, `Starting ${label}.`);

		try {
			return await task();
		} finally {
			this.syncInFlight = false;
			logVerbose(this, `Finished ${label}.`);
		}
	}
}
