const BASIC_MODEL_NAME = "Basic";

export function detectPreferredNewline(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeCardBody(text: string): string {
	return normalizeLineEndings(text).replace(/^\uFEFF/, "").trim();
}

export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function normalizeDeck(value: string | null | undefined): string {
	return value?.trim() ?? "";
}

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

export function normalizeCardUid(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}

	return value.startsWith("c_") ? value.slice(2) : value;
}

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

export function resolveEffectiveTags(
	globalTags: Iterable<string>,
	fileTags: Iterable<string>,
	cardTags: Iterable<string>,
): string[] {
	return normalizeTags([...globalTags, ...fileTags, ...cardTags]);
}

export function generateCardUid(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID().replace(/-/g, "");
	}

	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export async function computeCardRevision(input: {
	effectiveDeck: string;
	effectiveTags: string[];
	frontNormalized: string;
	backNormalized: string;
}): Promise<string> {
	const payload = JSON.stringify({
		model: BASIC_MODEL_NAME,
		deck: input.effectiveDeck,
		tags: normalizeTags(input.effectiveTags),
		front: input.frontNormalized,
		back: input.backNormalized,
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
