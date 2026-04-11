import { getLanguage } from "obsidian";

interface SettingText {
	name: string;
	desc: string;
	placeholder: string;
}

interface ToggleSettingText {
	name: string;
	desc: string;
}

interface SettingsPageTabText {
	label: string;
	description: string;
}

interface SettingsPageSectionText {
	name: string;
	desc: string;
}

interface SettingsPageText {
	title: string;
	description: string;
	tabs: {
		general: SettingsPageTabText;
		automation: SettingsPageTabText;
		cleanup: SettingsPageTabText;
		advanced: SettingsPageTabText;
	};
	sections: {
		deckDefaults: SettingsPageSectionText;
		ankiConnection: SettingsPageSectionText;
		incrementalSync: SettingsPageSectionText;
		startupReconcile: SettingsPageSectionText;
		deckCleanup: SettingsPageSectionText;
		bulkDeleteBackup: SettingsPageSectionText;
		noticesAndLogging: SettingsPageSectionText;
	};
}

export interface SettingsTexts {
	page: SettingsPageText;
	defaultDeck: SettingText;
	defaultTags: SettingText;
	ankiHost: SettingText;
	ankiPort: ToggleSettingText;
	autoCreateMissingDecks: ToggleSettingText;
	cleanupEmptyDecksEnabled: ToggleSettingText;
	backupBeforeBulkDelete: ToggleSettingText;
	backupBeforeBulkDeleteExportPath: SettingText;
	backupBeforeBulkDeleteThreshold: ToggleSettingText;
	reconcileOnStartup: ToggleSettingText;
	autoSyncEnabled: ToggleSettingText;
	autoSyncDelaySeconds: ToggleSettingText;
	showDetailedErrorNotices: ToggleSettingText;
	enableVerboseLogging: ToggleSettingText;
}

const ENGLISH_SETTINGS_TEXTS: SettingsTexts = {
	page: {
		title: "OBAK settings",
		description:
			"Browse OBAK options by task. Tabs reduce scrolling, and each card keeps related sync controls together.",
		tabs: {
			general: {
				label: "General",
				description:
					"Configure deck defaults and the local AnkiConnect endpoint used for sync.",
			},
			automation: {
				label: "Automation",
				description:
					"Tune how OBAK reacts to edits and when incremental sync starts.",
			},
			cleanup: {
				label: "Cleanup & backup",
				description:
					"Control empty deck cleanup and add a safety backup before large delete batches.",
			},
			advanced: {
				label: "Advanced",
				description:
					"Adjust notice verbosity and console logging for troubleshooting.",
			},
		},
		sections: {
			deckDefaults: {
				name: "Deck defaults",
				desc: "Choose the fallback deck root and tags used when notes do not define their own values.",
			},
			ankiConnection: {
				name: "Anki connection",
				desc: "Point OBAK at your local AnkiConnect service and decide whether missing decks can be created automatically.",
			},
			incrementalSync: {
				name: "Incremental sync",
				desc: "Watch file changes and queue incremental sync automatically after edits settle.",
			},
			startupReconcile: {
				name: "Startup reconcile",
				desc: "Check the local sync index at startup and queue deletes for vault files that no longer exist.",
			},
			deckCleanup: {
				name: "Deck cleanup",
				desc: "Remove empty child decks under the configured default root deck after sync completes.",
			},
			bulkDeleteBackup: {
				name: "Bulk delete backup",
				desc: "Export a safety backup before large delete batches so recovery stays easy.",
			},
			noticesAndLogging: {
				name: "Notices and logging",
				desc: "Choose how much runtime detail appears in notices and in the developer console.",
			},
		},
	},
	defaultDeck: {
		name: "Default deck",
		desc: "Acts as the root deck. If card and file decks are missing, try default deck::folder::note first, then default deck.",
		placeholder: "OBAK",
	},
	defaultTags: {
		name: "Default tags",
		desc: "Comma-separated tags merged into every card.",
		placeholder: "OBAK",
	},
	ankiHost: {
		name: "Anki host",
		desc: "Host used for local Anki sync requests.",
		placeholder: "127.0.0.1",
	},
	ankiPort: {
		name: "Anki port",
		desc: "Port used for local Anki sync requests.",
	},
	autoCreateMissingDecks: {
		name: "Auto-create missing decks",
		desc: "Create the target deck in Anki before adding notes when needed.",
	},
	cleanupEmptyDecksEnabled: {
		name: "Delete empty decks after sync",
		desc: "After sync finishes, delete empty child decks under the configured default root deck only.",
	},
	backupBeforeBulkDelete: {
		name: "Backup before bulk delete",
		desc: "When pending note deletions are greater than the threshold below, export the configured default deck before continuing.",
	},
	backupBeforeBulkDeleteExportPath: {
		name: "Bulk delete backup export path",
		desc: "Export directory or base .apkg path. A timestamped filename will be generated automatically from it.",
		placeholder: "Path to backup folder or .apkg file",
	},
	backupBeforeBulkDeleteThreshold: {
		name: "Bulk delete backup threshold",
		desc: "Trigger deck export only when pending note deletions are greater than this number. Set 0 to export before any delete.",
	},
	reconcileOnStartup: {
		name: "Reconcile on startup",
		desc: "Queue deletions for files missing from the vault at startup.",
	},
	autoSyncEnabled: {
		name: "Auto-sync incremental changes",
		desc: "Run incremental sync automatically after edits stop or tracked files change. Auto sync uses the pending change set since the last sync and never overlaps an in-flight sync.",
	},
	autoSyncDelaySeconds: {
		name: "Auto-sync delay (seconds)",
		desc: "How many seconds to wait after edits stop or tracked files change before incremental auto sync starts.",
	},
	showDetailedErrorNotices: {
		name: "Show detailed error notices",
		desc: "Show full parse and sync error details in notices instead of summary-only issue counts.",
	},
	enableVerboseLogging: {
		name: "Verbose console logging",
		desc: "Print detailed sync and file-tracking logs to the developer console.",
	},
};

const CHINESE_SETTINGS_TEXTS: SettingsTexts = {
	page: {
		title: "OBAK 设置",
		description:
			"按使用任务浏览 OBAK 配置。通过标签分组减少滚动距离，也让相关同步选项保持在同一张卡片里。",
		tabs: {
			general: {
				label: "常规",
				description: "配置默认牌组、标签，以及本地 AnkiConnect 连接信息。",
			},
			automation: {
				label: "自动化",
				description: "调整 OBAK 如何响应编辑，以及何时启动增量自动同步。",
			},
			cleanup: {
				label: "清理与备份",
				description: "控制空牌组清理策略，并在批量删除前加上一层备份保护。",
			},
			advanced: {
				label: "高级",
				description: "调整通知细节和控制台日志，便于排查问题。",
			},
		},
		sections: {
			deckDefaults: {
				name: "牌组默认值",
				desc: "配置笔记没有显式指定时使用的默认根牌组和默认标签。",
			},
			ankiConnection: {
				name: "Anki 连接",
				desc: "指定本地 AnkiConnect 服务地址，并决定缺失牌组是否允许自动创建。",
			},
			incrementalSync: {
				name: "增量同步",
				desc: "监听文件改动，并在编辑稳定后自动排队执行增量同步。",
			},
			startupReconcile: {
				name: "启动时对账",
				desc: "插件启动时检查本地同步索引，并为库中已不存在的文件排队删除。",
			},
			deckCleanup: {
				name: "牌组清理",
				desc: "同步完成后，清理已配置默认根牌组下面的空子牌组。",
			},
			bulkDeleteBackup: {
				name: "批量删除备份",
				desc: "在大批量删除前先导出安全备份，降低误删后的恢复成本。",
			},
			noticesAndLogging: {
				name: "通知与日志",
				desc: "控制运行时详情在通知和开发者控制台中的展示程度。",
			},
		},
	},
	defaultDeck: {
		name: "默认牌组",
		desc: "作为根牌组使用。当卡片和文件都没有指定牌组时，会先尝试“默认牌组::文件夹::笔记”，再回退到“默认牌组”。",
		placeholder: "OBAK",
	},
	defaultTags: {
		name: "默认标签",
		desc: "以逗号分隔的标签，会合并到每张卡片中。",
		placeholder: "OBAK",
	},
	ankiHost: {
		name: "Anki 主机",
		desc: "用于本地 Anki 同步请求的主机地址。",
		placeholder: "127.0.0.1",
	},
	ankiPort: {
		name: "Anki 端口",
		desc: "用于本地 Anki 同步请求的端口。",
	},
	autoCreateMissingDecks: {
		name: "自动创建缺失牌组",
		desc: "需要时，在添加笔记前先在 Anki 中创建目标牌组。",
	},
	cleanupEmptyDecksEnabled: {
		name: "同步后删除空牌组",
		desc: "同步结束后，仅删除已配置默认根牌组下面的空子牌组。",
	},
	backupBeforeBulkDelete: {
		name: "批量删除前备份",
		desc: "当待删除笔记数大于下方阈值时，继续前先导出已配置的默认牌组。",
	},
	backupBeforeBulkDeleteExportPath: {
		name: "批量删除备份导出路径",
		desc: "导出目录或 .apkg 基础路径。插件会基于它自动生成带时间戳的文件名。",
		placeholder: "备份文件夹或 .apkg 文件路径",
	},
	backupBeforeBulkDeleteThreshold: {
		name: "批量删除备份阈值",
		desc: "仅当待删除笔记数大于此数字时才触发牌组导出。设为 0 表示任何删除前都导出。",
	},
	reconcileOnStartup: {
		name: "启动时对账",
		desc: "启动时为库中已缺失的文件排队删除。",
	},
	autoSyncEnabled: {
		name: "自动同步增量改动",
		desc: "在编辑停止后，或跟踪文件发生变化后，自动运行增量同步。自动同步会基于上次同步后积累的待处理变更集执行，且不会与正在进行的同步重叠。",
	},
	autoSyncDelaySeconds: {
		name: "自动同步延迟（秒）",
		desc: "编辑停止或跟踪文件发生变化后，在启动增量自动同步之前等待的秒数。",
	},
	showDetailedErrorNotices: {
		name: "显示详细错误通知",
		desc: "在通知中显示完整的解析和同步错误详情，而不是只显示问题摘要计数。",
	},
	enableVerboseLogging: {
		name: "详细控制台日志",
		desc: "将详细的同步和文件跟踪日志输出到开发者控制台。",
	},
};

export function getSettingsTexts(): SettingsTexts {
	return getLanguage().toLowerCase().startsWith("zh")
		? CHINESE_SETTINGS_TEXTS
		: ENGLISH_SETTINGS_TEXTS;
}
