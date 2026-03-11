import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

export interface ObakSettings {
	defaultDeck: string;
	defaultTags: string[];
	ankiHost: string;
	ankiPort: number;
	autoCreateMissingDecks: boolean;
	reconcileOnStartup: boolean;
	showDetailedErrorNotices: boolean;
	enableVerboseLogging: boolean;
}

export const DEFAULT_SETTINGS: ObakSettings = {
	defaultDeck: "",
	defaultTags: [],
	ankiHost: "127.0.0.1",
	ankiPort: 8765,
	autoCreateMissingDecks: true,
	reconcileOnStartup: true,
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

export class ObakSettingTab extends PluginSettingTab {
	plugin: SettingsHost;

	constructor(app: App, plugin: Plugin & SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

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
