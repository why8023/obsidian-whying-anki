import type { App, TFile } from "obsidian";
import { renderMarkdownForAnki } from "./markdown-renderer";
import {
	detectPreferredNewline,
	normalizeCardBody,
	resolveEffectiveDeck,
	resolveEffectiveTags,
} from "./normalize";
import type { ObakSettings } from "./settings";
import { parseCardsFromMarkdown } from "./syntax";
import type { FileDefaults, ParsedCard, ScannedFile } from "./types";
import { buildObsidianFileUri } from "./uri";

/**
 * 批量扫描多个 Markdown 文件。
 * 这里只做 I/O 并发和结果聚合，单文件逻辑在 `scanMarkdownFile` 中。
 */
export async function scanMarkdownFiles(
	app: App,
	files: TFile[],
	settings: ObakSettings,
): Promise<ScannedFile[]> {
	return Promise.all(files.map((file) => scanMarkdownFile(app, file, settings)));
}

/**
 * 扫描单个 Markdown 文件并构造完整卡片对象。
 *
 * 处理顺序：
 * 1. 读取原始文本
 * 2. 解析 `card-start/card-back/card-end` 语法
 * 3. 读取 frontmatter 默认 deck/tags
 * 4. 归一化正反面内容并渲染成 Anki 可用 HTML
 * 5. 计算每张卡实际生效的 deck/tags/Obsidian URI
 */
export async function scanMarkdownFile(
	app: App,
	file: TFile,
	settings: ObakSettings,
): Promise<ScannedFile> {
	const text = await app.vault.read(file);
	const parsed = parseCardsFromMarkdown(text, file.path);
	const fileDefaults = readFileDefaults(app, file);
	const vaultName = app.vault.getName();

	const cards: ParsedCard[] = parsed.cards.map((card) => {
		// 每张卡都带上指向其源文件的 Obsidian URI，便于 Anki 反向打开原文。
		const obUri = buildObsidianFileUri(vaultName, file.path);
		const effectiveDeck = resolveEffectiveDeck(
			card.startMeta.deck,
			fileDefaults.deck,
			settings.defaultDeck,
			file.path,
		);
		const effectiveTags = resolveEffectiveTags(
			settings.defaultTags,
			fileDefaults.tags,
			card.startMeta.tags,
		);

		// front/back 先做文本归一化，再走 Markdown 渲染，确保 revision 计算和同步内容一致。
		const frontNormalized = renderMarkdownForAnki(normalizeCardBody(card.frontRaw));
		const backNormalized = renderMarkdownForAnki(normalizeCardBody(card.backRaw));

		return {
			...card,
			noteId: card.endMeta.noteId,
			fileMtime: file.stat.mtime,
			frontNormalized,
			backNormalized,
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
	// 文件级默认值来自 frontmatter：
	// anki-deck: "Deck::Child"
	// anki-tags: "tag1, tag2" 或 YAML 数组
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
	// 同时兼容 YAML 数组和逗号分隔字符串两种写法。
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
