import type { App, TFile } from "obsidian";
import { renderMarkdownMediaForAnki } from "./markdown-media";
import {
	detectPreferredNewline,
	normalizeCardBody,
	normalizeCardUid,
	resolveEffectiveDeck,
	resolveEffectiveTags,
} from "./normalize";
import type { WhyingAnkiSettings } from "./settings";
import { parseCardsFromMarkdown } from "./syntax";
import type { FileDefaults, ParsedCard, ScannedFile } from "./types";
import { appendObsidianLink, buildObsidianFileUri } from "./uri";

export async function scanMarkdownFiles(
	app: App,
	files: TFile[],
	settings: WhyingAnkiSettings,
): Promise<ScannedFile[]> {
	return Promise.all(files.map((file) => scanMarkdownFile(app, file, settings)));
}

export async function scanMarkdownFile(
	app: App,
	file: TFile,
	settings: WhyingAnkiSettings,
): Promise<ScannedFile> {
	const text = await app.vault.read(file);
	const parsed = parseCardsFromMarkdown(text, file.path);
	const fileDefaults = readFileDefaults(app, file);
	const vaultName = app.vault.getName();

	const cards: ParsedCard[] = parsed.cards.map((card) => {
		const obUri = buildObsidianFileUri(vaultName, file.path);
		const effectiveDeck = resolveEffectiveDeck(
			card.startMeta.deck,
			fileDefaults.deck,
			settings.defaultDeck,
		);
		const effectiveTags = resolveEffectiveTags(
			settings.defaultTags,
			fileDefaults.tags,
			card.startMeta.tags,
		);

		const frontNormalized = renderMarkdownMediaForAnki(normalizeCardBody(card.frontRaw));
		const backNormalizedBase = renderMarkdownMediaForAnki(normalizeCardBody(card.backRaw));

		return {
			...card,
			uid: normalizeCardUid(card.endMeta.uid),
			noteId: card.endMeta.noteId,
			rev: card.endMeta.rev,
			fileMtime: file.stat.mtime,
			frontNormalized,
			backNormalized: settings.appendObsidianUriToBack
				? appendObsidianLink(backNormalizedBase, obUri)
				: backNormalizedBase,
			effectiveDeck,
			effectiveTags,
			obUri,
		};
	});

	return {
		file,
		text,
		newline: detectPreferredNewline(text),
		cards,
		errors: parsed.errors,
	};
}

function readFileDefaults(app: App, file: TFile): FileDefaults {
	const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;

	return {
		deck:
			typeof frontmatter?.["anki-deck"] === "string"
				? frontmatter["anki-deck"].trim()
				: undefined,
		tags: normalizeFrontmatterTags(frontmatter?.["anki-tags"]),
	};
}

function normalizeFrontmatterTags(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value
			.filter((entry): entry is string => typeof entry === "string")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	if (typeof value === "string") {
		return value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean);
	}

	return [];
}
