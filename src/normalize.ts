import { OBAK_MODEL_NAME } from "./anki-model";

/**
 * 保留原文件换行风格，便于回写时尽量不影响用户已有格式。
 */
export function detectPreferredNewline(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * 归一化卡片正文：
 * 1. 统一换行
 * 2. 去掉 BOM
 * 3. 去掉首尾空白
 */
export function normalizeCardBody(text: string): string {
	return normalizeLineEndings(text).replace(/^\uFEFF/, "").trim();
}

/**
 * 把所有换行统一成 `\n`，方便解析、渲染和计算 revision。
 */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/**
 * 归一化 deck 名称；空值统一视作空字符串。
 */
export function normalizeDeck(value: string | null | undefined): string {
	return value?.trim() ?? "";
}

/**
 * 根据默认 deck 和文件路径推导 scoped default deck。
 * 例如默认 deck 为 `Biology`，文件路径为 `Cell/Intro.md`，
 * 则会尝试生成 `Biology::Cell::Intro`。
 */
export function buildScopedDefaultDeck(
	defaultDeck: string,
	filePath: string | null | undefined,
): string {
	const normalizedDefaultDeck = normalizeDeck(defaultDeck);
	if (!normalizedDefaultDeck) {
		return "";
	}

	const pathSegments = normalizeVaultPathToDeckSegments(filePath);
	return pathSegments.length > 0
		? `${normalizedDefaultDeck}::${pathSegments.join("::")}`
		: "";
}

/**
 * 归一化标签集合：trim、去重、排序。
 * 排序后可让 revision 计算和持久化结果保持稳定。
 */
export function normalizeTags(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}

		seen.add(trimmed);
		normalized.push(trimmed);
	}

	return normalized.sort((left, right) => left.localeCompare(right));
}

/**
 * 解析一张卡最终应该落到哪个 deck。
 * 优先级：卡片 deck > 文件 deck > scoped default deck > default deck。
 */
export function resolveEffectiveDeck(
	cardDeck: string | null | undefined,
	fileDeck: string | null | undefined,
	defaultDeck: string,
	filePath?: string,
): string {
	return (
		normalizeDeck(cardDeck) ||
		normalizeDeck(fileDeck) ||
		buildScopedDefaultDeck(defaultDeck, filePath) ||
		normalizeDeck(defaultDeck)
	);
}

/**
 * 合并全局、文件级和卡片级标签。
 */
export function resolveEffectiveTags(
	globalTags: Iterable<string>,
	fileTags: Iterable<string>,
	cardTags: Iterable<string>,
): string[] {
	return normalizeTags([...globalTags, ...fileTags, ...cardTags]);
}

/**
 * 生成新的卡片 UID。
 * 优先使用浏览器环境提供的 `crypto.randomUUID`，否则退回到时间戳 + 随机串。
 */
export function generateCardUid(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID().replace(/-/g, "");
	}

	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 计算卡片修订签名。
 * 只要会影响 Anki 实际内容或定位的信息变化，就会得到新的 hash，从而触发更新。
 */
export async function computeCardRevision(input: {
	effectiveDeck: string;
	effectiveTags: string[];
	frontNormalized: string;
	backNormalized: string;
	obUri: string;
	obsidianPath: string;
}): Promise<string> {
	// 把参与同步判定的关键字段序列化后做 SHA-256，得到稳定 revision。
	const payload = JSON.stringify({
		model: OBAK_MODEL_NAME,
		deck: input.effectiveDeck,
		tags: normalizeTags(input.effectiveTags),
		front: input.frontNormalized,
		back: input.backNormalized,
		obUri: input.obUri,
		path: input.obsidianPath,
	});

	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(payload),
	);

	return `sha256:${toHex(new Uint8Array(digest))}`;
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeVaultPathToDeckSegments(
	filePath: string | null | undefined,
): string[] {
	// 把 vault 路径拆成 deck 段，最后一段去掉 `.md`，用于 scoped default deck 推导。
	if (!filePath) {
		return [];
	}

	const rawSegments = filePath
		.split(/[\\/]/)
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (rawSegments.length === 0) {
		return [];
	}

	const lastIndex = rawSegments.length - 1;
	return rawSegments
		.map((segment, index) =>
			index === lastIndex ? segment.replace(/\.md$/i, "").trim() : segment,
		)
		.filter(Boolean);
}
