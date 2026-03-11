import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

/**
 * 插件设置。
 * 这些配置既影响扫描行为，也影响同步到 Anki 的运行方式。
 */
export interface ObakSettings {
	// 全局默认牌组；当卡片和文件都没声明 deck 时，插件会优先推导 scoped deck。
	defaultDeck: string;
	// 会合并进所有卡片的默认标签。
	defaultTags: string[];
	// AnkiConnect 服务地址。
	ankiHost: string;
	ankiPort: number;
	// 是否在同步前自动创建缺失牌组。
	autoCreateMissingDecks: boolean;
	backupBeforeBulkDeleteEnabled: boolean;
	backupBeforeBulkDeleteExportPath: string;
	backupBeforeBulkDeleteThreshold: number;
	// 插件启动时是否自动对账缺失文件。
	reconcileOnStartup: boolean;
	// notice 中显示完整错误列表，还是只显示摘要。
	showDetailedErrorNotices: boolean;
	// 是否把详细调试信息打印到开发者控制台。
	enableVerboseLogging: boolean;
}

/**
 * 默认设置。
 */
export const DEFAULT_SETTINGS: ObakSettings = {
	defaultDeck: "",
	defaultTags: [],
	ankiHost: "127.0.0.1",
	ankiPort: 8765,
	autoCreateMissingDecks: true,
	backupBeforeBulkDeleteEnabled: false,
	backupBeforeBulkDeleteExportPath: "",
	backupBeforeBulkDeleteThreshold: 20,
	reconcileOnStartup: true,
	showDetailedErrorNotices: false,
	enableVerboseLogging: false,
};

// 设置面板只依赖这一小组能力，避免和完整插件类强耦合。
interface SettingsHost {
	settings: ObakSettings;
	savePluginData(): Promise<void>;
}

/**
 * 从持久化数据中加载设置，并对每个字段做安全归一化。
 * 这样可以兼容旧版本数据、手工编辑损坏的数据，或缺省字段。
 */
export function loadSettings(settings?: unknown): ObakSettings {
	const normalized = cloneSettings(DEFAULT_SETTINGS);
	if (!isStringRecord(settings)) {
		return normalized;
	}

	if (typeof settings.defaultDeck === "string") {
		normalized.defaultDeck = settings.defaultDeck;
	}

	if (isStringArray(settings.defaultTags)) {
		normalized.defaultTags = [...settings.defaultTags];
	}

	if (typeof settings.ankiHost === "string") {
		normalized.ankiHost = settings.ankiHost;
	}

	if (
		typeof settings.ankiPort === "number" &&
		Number.isInteger(settings.ankiPort) &&
		settings.ankiPort > 0
	) {
		normalized.ankiPort = settings.ankiPort;
	}

	if (typeof settings.autoCreateMissingDecks === "boolean") {
		normalized.autoCreateMissingDecks = settings.autoCreateMissingDecks;
	}

	if (typeof settings.backupBeforeBulkDeleteEnabled === "boolean") {
		normalized.backupBeforeBulkDeleteEnabled = settings.backupBeforeBulkDeleteEnabled;
	}

	if (typeof settings.backupBeforeBulkDeleteExportPath === "string") {
		normalized.backupBeforeBulkDeleteExportPath = settings.backupBeforeBulkDeleteExportPath;
	}

	if (
		typeof settings.backupBeforeBulkDeleteThreshold === "number" &&
		Number.isInteger(settings.backupBeforeBulkDeleteThreshold) &&
		settings.backupBeforeBulkDeleteThreshold >= 0
	) {
		normalized.backupBeforeBulkDeleteThreshold = settings.backupBeforeBulkDeleteThreshold;
	}

	if (typeof settings.reconcileOnStartup === "boolean") {
		normalized.reconcileOnStartup = settings.reconcileOnStartup;
	}

	if (typeof settings.showDetailedErrorNotices === "boolean") {
		normalized.showDetailedErrorNotices = settings.showDetailedErrorNotices;
	}

	if (typeof settings.enableVerboseLogging === "boolean") {
		normalized.enableVerboseLogging = settings.enableVerboseLogging;
	}

	return normalized;
}

/**
 * Obsidian 设置页实现。
 * 这里只负责 UI 和保存行为，不做复杂业务逻辑。
 */
export class ObakSettingTab extends PluginSettingTab {
	plugin: SettingsHost;

	constructor(app: App, plugin: Plugin & SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// 每个设置项改动后立刻持久化，避免需要单独的“保存”按钮。
		new Setting(containerEl)
			.setName("Default deck")
			.setDesc(
				"Acts as the root deck. If card and file decks are missing, try default deck::folder::note first, then default deck.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Biology::cell")
					.setValue(this.plugin.settings.defaultDeck)
					.onChange(async (value) => {
						this.plugin.settings.defaultDeck = value.trim();
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Default tags")
			.setDesc("Comma-separated tags merged into every card.")
			.addText((text) =>
				text
					.setPlaceholder("Bio, exam")
					.setValue(this.plugin.settings.defaultTags.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.defaultTags = parseCommaSeparated(value);
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Anki host")
			.setDesc("Host used for local Anki sync requests.")
			.addText((text) =>
				text
					.setPlaceholder("127.0.0.1")
					.setValue(this.plugin.settings.ankiHost)
					.onChange(async (value) => {
						this.plugin.settings.ankiHost = value.trim() || DEFAULT_SETTINGS.ankiHost;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Anki port")
			.setDesc("Port used for local Anki sync requests.")
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.ankiPort))
					.setValue(String(this.plugin.settings.ankiPort))
					.onChange(async (value) => {
						const port = Number.parseInt(value, 10);
						if (Number.isInteger(port) && port > 0) {
							this.plugin.settings.ankiPort = port;
							await this.plugin.savePluginData();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Auto-create missing decks")
			.setDesc("Create the target deck in Anki before adding notes when needed.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCreateMissingDecks)
					.onChange(async (value) => {
						this.plugin.settings.autoCreateMissingDecks = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Backup before bulk delete")
			.setDesc(
				"When pending note deletions are greater than the threshold below, export the configured default deck before continuing.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.backupBeforeBulkDeleteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.backupBeforeBulkDeleteEnabled = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Bulk delete backup export path")
			.setDesc(
				"Export directory or base .apkg path. A timestamped filename will be generated automatically from it.",
			)
			.addText((text) =>
				text
					.setPlaceholder("D:\\AnkiBackups")
					.setValue(this.plugin.settings.backupBeforeBulkDeleteExportPath)
					.onChange(async (value) => {
						this.plugin.settings.backupBeforeBulkDeleteExportPath = value.trim();
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Bulk delete backup threshold")
			.setDesc(
				"Trigger deck export only when pending note deletions are greater than this number. Set 0 to export before any delete.",
			)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				return text
					.setPlaceholder(String(DEFAULT_SETTINGS.backupBeforeBulkDeleteThreshold))
					.setValue(String(this.plugin.settings.backupBeforeBulkDeleteThreshold))
					.onChange(async (value) => {
						const threshold = Number.parseInt(value, 10);
						if (Number.isInteger(threshold) && threshold >= 0) {
							this.plugin.settings.backupBeforeBulkDeleteThreshold = threshold;
							await this.plugin.savePluginData();
						}
					});
			});

		new Setting(containerEl)
			.setName("Reconcile on startup")
			.setDesc("Queue deletions for files missing from the vault at startup.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.reconcileOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.reconcileOnStartup = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Show detailed error notices")
			.setDesc(
				"Show full parse and sync error details in notices instead of summary-only issue counts.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDetailedErrorNotices)
					.onChange(async (value) => {
						this.plugin.settings.showDetailedErrorNotices = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Verbose console logging")
			.setDesc(
				"Print detailed sync and file-tracking logs to the developer console.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableVerboseLogging)
					.onChange(async (value) => {
						this.plugin.settings.enableVerboseLogging = value;
						await this.plugin.savePluginData();
					}),
			);
	}
}

function cloneSettings(settings: ObakSettings): ObakSettings {
	// `defaultTags` 是数组，需要复制，避免调用方修改原对象。
	return {
		...settings,
		defaultTags: [...settings.defaultTags],
	};
}

function parseCommaSeparated(value: string): string[] {
	// 统一做 trim 和去重，保证配置里标签顺序稳定且没有空项。
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const tag of value.split(",")) {
		const trimmed = tag.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}

		seen.add(trimmed);
		normalized.push(trimmed);
	}

	return normalized;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
