import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { getSettingsTexts } from "./settings-text";

export interface ObakSettings {
	defaultDeck: string;
	defaultTags: string[];
	ankiHost: string;
	ankiPort: number;
	autoCreateMissingDecks: boolean;
	backupBeforeBulkDeleteEnabled: boolean;
	backupBeforeBulkDeleteExportPath: string;
	backupBeforeBulkDeleteThreshold: number;
	autoSyncEnabled: boolean;
	reconcileOnStartup: boolean;
	showDetailedErrorNotices: boolean;
	enableVerboseLogging: boolean;
}

export const DEFAULT_SETTINGS: ObakSettings = {
	defaultDeck: "OBAK",
	defaultTags: ["OBAK"],
	ankiHost: "127.0.0.1",
	ankiPort: 8765,
	autoCreateMissingDecks: true,
	backupBeforeBulkDeleteEnabled: false,
	backupBeforeBulkDeleteExportPath: "",
	backupBeforeBulkDeleteThreshold: 20,
	reconcileOnStartup: true,
	autoSyncEnabled: false,
	showDetailedErrorNotices: false,
	enableVerboseLogging: false,
};

interface SettingsHost {
	settings: ObakSettings;
	savePluginData(): Promise<void>;
}

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

	if (typeof settings.autoSyncEnabled === "boolean") {
		normalized.autoSyncEnabled = settings.autoSyncEnabled;
	}

	if (typeof settings.showDetailedErrorNotices === "boolean") {
		normalized.showDetailedErrorNotices = settings.showDetailedErrorNotices;
	}

	if (typeof settings.enableVerboseLogging === "boolean") {
		normalized.enableVerboseLogging = settings.enableVerboseLogging;
	}

	return normalized;
}

export class ObakSettingTab extends PluginSettingTab {
	plugin: SettingsHost;

	constructor(app: App, plugin: Plugin & SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const texts = getSettingsTexts();
		containerEl.empty();

		new Setting(containerEl)
			.setName(texts.defaultDeck.name)
			.setDesc(texts.defaultDeck.desc)
			.addText((text) =>
				text
					.setPlaceholder(texts.defaultDeck.placeholder)
					.setValue(this.plugin.settings.defaultDeck)
					.onChange(async (value) => {
						this.plugin.settings.defaultDeck = value.trim();
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.defaultTags.name)
			.setDesc(texts.defaultTags.desc)
			.addText((text) =>
				text
					.setPlaceholder(texts.defaultTags.placeholder)
					.setValue(this.plugin.settings.defaultTags.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.defaultTags = parseCommaSeparated(value);
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.ankiHost.name)
			.setDesc(texts.ankiHost.desc)
			.addText((text) =>
				text
					.setPlaceholder(texts.ankiHost.placeholder)
					.setValue(this.plugin.settings.ankiHost)
					.onChange(async (value) => {
						this.plugin.settings.ankiHost = value.trim() || DEFAULT_SETTINGS.ankiHost;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.ankiPort.name)
			.setDesc(texts.ankiPort.desc)
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
			.setName(texts.autoCreateMissingDecks.name)
			.setDesc(texts.autoCreateMissingDecks.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCreateMissingDecks)
					.onChange(async (value) => {
						this.plugin.settings.autoCreateMissingDecks = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.backupBeforeBulkDelete.name)
			.setDesc(texts.backupBeforeBulkDelete.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.backupBeforeBulkDeleteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.backupBeforeBulkDeleteEnabled = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.backupBeforeBulkDeleteExportPath.name)
			.setDesc(texts.backupBeforeBulkDeleteExportPath.desc)
			.addText((text) =>
				text
					.setPlaceholder(texts.backupBeforeBulkDeleteExportPath.placeholder)
					.setValue(this.plugin.settings.backupBeforeBulkDeleteExportPath)
					.onChange(async (value) => {
						this.plugin.settings.backupBeforeBulkDeleteExportPath = value.trim();
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.backupBeforeBulkDeleteThreshold.name)
			.setDesc(texts.backupBeforeBulkDeleteThreshold.desc)
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
			.setName(texts.reconcileOnStartup.name)
			.setDesc(texts.reconcileOnStartup.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.reconcileOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.reconcileOnStartup = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.autoSyncEnabled.name)
			.setDesc(texts.autoSyncEnabled.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.showDetailedErrorNotices.name)
			.setDesc(texts.showDetailedErrorNotices.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDetailedErrorNotices)
					.onChange(async (value) => {
						this.plugin.settings.showDetailedErrorNotices = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName(texts.enableVerboseLogging.name)
			.setDesc(texts.enableVerboseLogging.desc)
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
	return {
		...settings,
		defaultTags: [...settings.defaultTags],
	};
}

function parseCommaSeparated(value: string): string[] {
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
