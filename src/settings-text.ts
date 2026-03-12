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

export interface SettingsTexts {
	defaultDeck: SettingText;
	defaultTags: SettingText;
	ankiHost: SettingText;
	ankiPort: ToggleSettingText;
	autoCreateMissingDecks: ToggleSettingText;
	backupBeforeBulkDelete: ToggleSettingText;
	backupBeforeBulkDeleteExportPath: SettingText;
	backupBeforeBulkDeleteThreshold: ToggleSettingText;
	reconcileOnStartup: ToggleSettingText;
	autoSyncEnabled: ToggleSettingText;
	showDetailedErrorNotices: ToggleSettingText;
	enableVerboseLogging: ToggleSettingText;
}

const ENGLISH_SETTINGS_TEXTS: SettingsTexts = {
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
		desc: "Wait 5 seconds after edits stop or tracked files change, then run incremental sync automatically. Auto sync uses the pending change set since the last sync and never overlaps an in-flight sync.",
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
		desc: "在编辑停止 5 秒后，或跟踪文件发生变化后，自动运行增量同步。自动同步会基于上次同步后积累的待处理变更集执行，且不会与正在进行的同步重叠。",
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
