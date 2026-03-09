import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

export interface WhyingAnkiSettings {
	defaultDeck: string;
	defaultTags: string[];
	ankiHost: string;
	ankiPort: number;
	appendObsidianUriToBack: boolean;
	reconcileOnStartup: boolean;
}

export const DEFAULT_SETTINGS: WhyingAnkiSettings = {
	defaultDeck: "",
	defaultTags: [],
	ankiHost: "127.0.0.1",
	ankiPort: 8765,
	appendObsidianUriToBack: true,
	reconcileOnStartup: true,
};

interface SettingsHost {
	settings: WhyingAnkiSettings;
	savePluginData(): Promise<void>;
}

export function normalizeSettings(
	settings?: Partial<WhyingAnkiSettings>,
): WhyingAnkiSettings {
	return {
		defaultDeck: settings?.defaultDeck?.trim() ?? DEFAULT_SETTINGS.defaultDeck,
		defaultTags: normalizeStoredTags(settings?.defaultTags),
		ankiHost: settings?.ankiHost?.trim() || DEFAULT_SETTINGS.ankiHost,
		ankiPort:
			typeof settings?.ankiPort === "number" && Number.isInteger(settings.ankiPort)
				? settings.ankiPort
				: DEFAULT_SETTINGS.ankiPort,
		appendObsidianUriToBack:
			settings?.appendObsidianUriToBack ??
			DEFAULT_SETTINGS.appendObsidianUriToBack,
		reconcileOnStartup:
			settings?.reconcileOnStartup ?? DEFAULT_SETTINGS.reconcileOnStartup,
	};
}

export class WhyingAnkiSettingTab extends PluginSettingTab {
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
			.setDesc("Used when neither frontmatter nor card metadata provides a deck.")
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
			.setDesc("Reserved for phase 2 Anki integration.")
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
			.setDesc("Reserved for phase 2 Anki integration.")
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
			.setName("Append Obsidian link")
			.setDesc("Reserved for phase 4 source-link injection.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.appendObsidianUriToBack)
					.onChange(async (value) => {
						this.plugin.settings.appendObsidianUriToBack = value;
						await this.plugin.savePluginData();
					}),
			);

		new Setting(containerEl)
			.setName("Reconcile on startup")
			.setDesc("Reserved for phase 3 path reconciliation.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.reconcileOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.reconcileOnStartup = value;
						await this.plugin.savePluginData();
					}),
			);
	}
}

function normalizeStoredTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === "string")
			.flatMap((entry) => parseCommaSeparated(entry));
	}

	if (typeof value === "string") {
		return parseCommaSeparated(value);
	}

	return [...DEFAULT_SETTINGS.defaultTags];
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
