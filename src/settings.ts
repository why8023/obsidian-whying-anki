import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { getSettingsTexts, type SettingsTexts } from "./settings-text";

export interface ObakSettings {
	defaultDeck: string;
	defaultTags: string[];
	ankiHost: string;
	ankiPort: number;
	autoCreateMissingDecks: boolean;
	cleanupEmptyDecksEnabled: boolean;
	backupBeforeBulkDeleteEnabled: boolean;
	backupBeforeBulkDeleteExportPath: string;
	backupBeforeBulkDeleteThreshold: number;
	autoSyncEnabled: boolean;
	autoSyncDelaySeconds: number;
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
	cleanupEmptyDecksEnabled: true,
	backupBeforeBulkDeleteEnabled: false,
	backupBeforeBulkDeleteExportPath: "",
	backupBeforeBulkDeleteThreshold: 20,
	reconcileOnStartup: true,
	autoSyncEnabled: false,
	autoSyncDelaySeconds: 5,
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

	if (typeof settings.cleanupEmptyDecksEnabled === "boolean") {
		normalized.cleanupEmptyDecksEnabled = settings.cleanupEmptyDecksEnabled;
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

	if (
		typeof settings.autoSyncDelaySeconds === "number" &&
		Number.isInteger(settings.autoSyncDelaySeconds) &&
		settings.autoSyncDelaySeconds >= 1
	) {
		normalized.autoSyncDelaySeconds = settings.autoSyncDelaySeconds;
	}

	if (typeof settings.showDetailedErrorNotices === "boolean") {
		normalized.showDetailedErrorNotices = settings.showDetailedErrorNotices;
	}

	if (typeof settings.enableVerboseLogging === "boolean") {
		normalized.enableVerboseLogging = settings.enableVerboseLogging;
	}

	return normalized;
}

type SettingsPageTabId = "general" | "automation" | "cleanup" | "advanced";

interface SettingsPageTabDefinition {
	description: string;
	id: SettingsPageTabId;
	label: string;
}

export class ObakSettingTab extends PluginSettingTab {
	plugin: SettingsHost;
	private activeTab: SettingsPageTabId = "general";

	constructor(app: App, plugin: Plugin & SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const texts = getSettingsTexts();
		containerEl.empty();
		const tabContentEl = this.renderSettingsPageChrome(containerEl, texts);
		this.renderActiveTab(tabContentEl, texts);
	}

	private getSettingsPageTabs(texts: SettingsTexts): readonly SettingsPageTabDefinition[] {
		return [
			{
				description: texts.page.tabs.general.description,
				id: "general",
				label: texts.page.tabs.general.label,
			},
			{
				description: texts.page.tabs.automation.description,
				id: "automation",
				label: texts.page.tabs.automation.label,
			},
			{
				description: texts.page.tabs.cleanup.description,
				id: "cleanup",
				label: texts.page.tabs.cleanup.label,
			},
			{
				description: texts.page.tabs.advanced.description,
				id: "advanced",
				label: texts.page.tabs.advanced.label,
			},
		];
	}

	private saveSettings(): Promise<void> {
		return this.plugin.savePluginData();
	}

	private renderSettingsPageChrome(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): HTMLElement {
		containerEl.addClass("obak-settings-root");

		const tabs = this.getSettingsPageTabs(texts);
		const activeTab = tabs.find((tab) => tab.id === this.activeTab) ?? tabs[0]!;
		this.activeTab = activeTab.id;

		const pageEl = containerEl.createDiv({ cls: "obak-settings-page" });
		const heroEl = pageEl.createDiv({ cls: "obak-settings-hero" });
		const titleSetting = new Setting(heroEl)
			.setName(texts.page.title)
			.setHeading();
		titleSetting.settingEl.addClass("obak-settings-page-heading");
		heroEl.createEl("p", {
			cls: "obak-settings-page-description",
			text: texts.page.description,
		});

		const tabsEl = pageEl.createDiv({ cls: "obak-settings-tabs-nav" });
		tabsEl.setAttr("role", "tablist");

		tabs.forEach((tab) => {
			const buttonEl = tabsEl.createEl("button", {
				cls: "obak-settings-tab-button",
				text: tab.label,
			});
			buttonEl.type = "button";
			buttonEl.setAttr("role", "tab");
			buttonEl.setAttr("aria-selected", String(tab.id === activeTab.id));

			if (tab.id === activeTab.id) {
				buttonEl.addClass("is-active");
			}

			buttonEl.addEventListener("click", () => {
				if (this.activeTab === tab.id) {
					return;
				}

				this.activeTab = tab.id;
				this.display();
			});
		});

		pageEl.createEl("p", {
			cls: "obak-settings-tab-description",
			text: activeTab.description,
		});

		return pageEl.createDiv({ cls: "obak-settings-tab-content" });
	}

	private renderSettingsPanel(
		containerEl: HTMLElement,
		renderContent: (panelBodyEl: HTMLElement) => void,
	): void {
		const panelEl = containerEl.createDiv({ cls: "obak-settings-panel" });
		const panelBodyEl = panelEl.createDiv({ cls: "obak-settings-panel-body" });
		renderContent(panelBodyEl);
	}

	private renderActiveTab(containerEl: HTMLElement, texts: SettingsTexts): void {
		switch (this.activeTab) {
			case "general":
				this.renderGeneralTab(containerEl, texts);
				break;
			case "automation":
				this.renderAutomationTab(containerEl, texts);
				break;
			case "cleanup":
				this.renderCleanupTab(containerEl, texts);
				break;
			case "advanced":
				this.renderAdvancedTab(containerEl, texts);
				break;
		}
	}

	private renderGeneralTab(containerEl: HTMLElement, texts: SettingsTexts): void {
		this.renderSettingsPanel(containerEl, (panelBodyEl) => {
			this.renderDeckDefaultsSection(panelBodyEl, texts);
		});
		this.renderSettingsPanel(containerEl, (panelBodyEl) => {
			this.renderAnkiConnectionSection(panelBodyEl, texts);
		});
	}

	private renderAutomationTab(containerEl: HTMLElement, texts: SettingsTexts): void {
		this.renderSettingsPanel(containerEl, (panelBodyEl) => {
			this.renderIncrementalSyncSection(panelBodyEl, texts);
		});
		this.renderSettingsPanel(containerEl, (panelBodyEl) => {
			this.renderStartupReconcileSection(panelBodyEl, texts);
		});
	}

	private renderCleanupTab(containerEl: HTMLElement, texts: SettingsTexts): void {
		this.renderSettingsPanel(containerEl, (panelBodyEl) => {
			this.renderDeckCleanupSection(panelBodyEl, texts);
		});
		this.renderSettingsPanel(containerEl, (panelBodyEl) => {
			this.renderBulkDeleteBackupSection(panelBodyEl, texts);
		});
	}

	private renderAdvancedTab(containerEl: HTMLElement, texts: SettingsTexts): void {
		this.renderSettingsPanel(containerEl, (panelBodyEl) => {
			this.renderNoticesAndLoggingSection(panelBodyEl, texts);
		});
	}

	private renderDeckDefaultsSection(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): void {
		new Setting(containerEl)
			.setName(texts.page.sections.deckDefaults.name)
			.setDesc(texts.page.sections.deckDefaults.desc)
			.setHeading();

		new Setting(containerEl)
			.setName(texts.defaultDeck.name)
			.setDesc(texts.defaultDeck.desc)
			.addText((text) =>
				text
					.setPlaceholder(texts.defaultDeck.placeholder)
					.setValue(this.plugin.settings.defaultDeck)
					.onChange(async (value) => {
						this.plugin.settings.defaultDeck = value.trim();
						await this.saveSettings();
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
						await this.saveSettings();
					}),
			);
	}

	private renderAnkiConnectionSection(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): void {
		new Setting(containerEl)
			.setName(texts.page.sections.ankiConnection.name)
			.setDesc(texts.page.sections.ankiConnection.desc)
			.setHeading();

		new Setting(containerEl)
			.setName(texts.ankiHost.name)
			.setDesc(texts.ankiHost.desc)
			.addText((text) =>
				text
					.setPlaceholder(texts.ankiHost.placeholder)
					.setValue(this.plugin.settings.ankiHost)
					.onChange(async (value) => {
						this.plugin.settings.ankiHost =
							value.trim() || DEFAULT_SETTINGS.ankiHost;
						await this.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(texts.ankiPort.name)
			.setDesc(texts.ankiPort.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				return text
					.setPlaceholder(String(DEFAULT_SETTINGS.ankiPort))
					.setValue(String(this.plugin.settings.ankiPort))
					.onChange(async (value) => {
						const port = Number.parseInt(value, 10);
						if (Number.isInteger(port) && port > 0) {
							this.plugin.settings.ankiPort = port;
							await this.saveSettings();
						}
					});
			});

		new Setting(containerEl)
			.setName(texts.autoCreateMissingDecks.name)
			.setDesc(texts.autoCreateMissingDecks.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoCreateMissingDecks)
					.onChange(async (value) => {
						this.plugin.settings.autoCreateMissingDecks = value;
						await this.saveSettings();
					}),
			);
	}

	private renderIncrementalSyncSection(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): void {
		new Setting(containerEl)
			.setName(texts.page.sections.incrementalSync.name)
			.setDesc(texts.page.sections.incrementalSync.desc)
			.setHeading();

		new Setting(containerEl)
			.setName(texts.autoSyncEnabled.name)
			.setDesc(texts.autoSyncEnabled.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSyncEnabled)
					.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(texts.autoSyncDelaySeconds.name)
			.setDesc(texts.autoSyncDelaySeconds.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				return text
					.setPlaceholder(String(DEFAULT_SETTINGS.autoSyncDelaySeconds))
					.setValue(String(this.plugin.settings.autoSyncDelaySeconds))
					.onChange(async (value) => {
						const delaySeconds = Number.parseInt(value, 10);
						if (Number.isInteger(delaySeconds) && delaySeconds >= 1) {
							this.plugin.settings.autoSyncDelaySeconds = delaySeconds;
							await this.saveSettings();
						}
					});
			});
	}

	private renderStartupReconcileSection(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): void {
		new Setting(containerEl)
			.setName(texts.page.sections.startupReconcile.name)
			.setDesc(texts.page.sections.startupReconcile.desc)
			.setHeading();

		new Setting(containerEl)
			.setName(texts.reconcileOnStartup.name)
			.setDesc(texts.reconcileOnStartup.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.reconcileOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.reconcileOnStartup = value;
						await this.saveSettings();
					}),
			);
	}

	private renderDeckCleanupSection(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): void {
		new Setting(containerEl)
			.setName(texts.page.sections.deckCleanup.name)
			.setDesc(texts.page.sections.deckCleanup.desc)
			.setHeading();

		new Setting(containerEl)
			.setName(texts.cleanupEmptyDecksEnabled.name)
			.setDesc(texts.cleanupEmptyDecksEnabled.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.cleanupEmptyDecksEnabled)
					.onChange(async (value) => {
						this.plugin.settings.cleanupEmptyDecksEnabled = value;
						await this.saveSettings();
					}),
			);
	}

	private renderBulkDeleteBackupSection(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): void {
		new Setting(containerEl)
			.setName(texts.page.sections.bulkDeleteBackup.name)
			.setDesc(texts.page.sections.bulkDeleteBackup.desc)
			.setHeading();

		new Setting(containerEl)
			.setName(texts.backupBeforeBulkDelete.name)
			.setDesc(texts.backupBeforeBulkDelete.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.backupBeforeBulkDeleteEnabled)
					.onChange(async (value) => {
						this.plugin.settings.backupBeforeBulkDeleteEnabled = value;
						await this.saveSettings();
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
						this.plugin.settings.backupBeforeBulkDeleteExportPath =
							value.trim();
						await this.saveSettings();
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
							this.plugin.settings.backupBeforeBulkDeleteThreshold =
								threshold;
							await this.saveSettings();
						}
					});
			});
	}

	private renderNoticesAndLoggingSection(
		containerEl: HTMLElement,
		texts: SettingsTexts,
	): void {
		new Setting(containerEl)
			.setName(texts.page.sections.noticesAndLogging.name)
			.setDesc(texts.page.sections.noticesAndLogging.desc)
			.setHeading();

		new Setting(containerEl)
			.setName(texts.showDetailedErrorNotices.name)
			.setDesc(texts.showDetailedErrorNotices.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDetailedErrorNotices)
					.onChange(async (value) => {
						this.plugin.settings.showDetailedErrorNotices = value;
						await this.saveSettings();
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
						await this.saveSettings();
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
