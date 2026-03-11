type MediaKind = "audio" | "image" | "video";

// 解析成功后的媒体嵌入信息。
interface ParsedMediaEmbed {
	alt: string;
	endOffset: number;
	title: string | null;
	url: string;
}

const IMAGE_EXTENSIONS = new Set([
	".apng",
	".avif",
	".bmp",
	".gif",
	".jpeg",
	".jpg",
	".png",
	".svg",
	".webp",
]);

const AUDIO_EXTENSIONS = new Set([
	".aac",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".ogg",
	".opus",
	".wav",
]);

const VIDEO_EXTENSIONS = new Set([
	".m4v",
	".mov",
	".mp4",
	".ogv",
	".webm",
]);

/**
 * 把远程图片/音频/视频形式的 Markdown 嵌入转换成原生 HTML 标签。
 * 当前只接受 http/https 远程资源；本地附件保持原文不动。
 */
export function renderMarkdownMediaForAnki(text: string): string {
	if (!text.includes("![")) {
		return text;
	}

	let cursor = 0;
	let transformed = "";

	while (cursor < text.length) {
		const embedOffset = text.indexOf("![", cursor);
		if (embedOffset === -1) {
			transformed += text.slice(cursor);
			break;
		}

		const parsedEmbed = parseMediaEmbed(text, embedOffset);
		if (!parsedEmbed) {
			transformed += text.slice(cursor, embedOffset + 2);
			cursor = embedOffset + 2;
			continue;
		}

		const mediaKind = detectMediaKind(parsedEmbed.url);
		if (!mediaKind) {
			// 不认识的扩展名保持原 Markdown，避免误转换。
			transformed += text.slice(cursor, parsedEmbed.endOffset);
			cursor = parsedEmbed.endOffset;
			continue;
		}

		transformed += text.slice(cursor, embedOffset);
		transformed += renderMediaHtml(mediaKind, parsedEmbed);
		cursor = parsedEmbed.endOffset;
	}

	return transformed;
}

function parseMediaEmbed(text: string, startOffset: number): ParsedMediaEmbed | null {
	// 只处理标准 `![alt](url "title")` 结构。
	if (!text.startsWith("![", startOffset)) {
		return null;
	}

	const altStart = startOffset + 1;
	const altEnd = findMatchingDelimiter(text, altStart, "[", "]");
	if (altEnd === null || text.charAt(altEnd + 1) !== "(") {
		return null;
	}

	const destinationStart = altEnd + 1;
	const destinationEnd = findMatchingDelimiter(text, destinationStart, "(", ")");
	if (destinationEnd === null) {
		return null;
	}

	const destination = parseDestination(text.slice(destinationStart + 1, destinationEnd));
	if (!destination) {
		return null;
	}

	return {
		alt: unescapeMarkdownText(text.slice(altStart + 1, altEnd)),
		endOffset: destinationEnd + 1,
		title: destination.title,
		url: destination.url,
	};
}

function parseDestination(rawDestination: string): { title: string | null; url: string } | null {
	// 兼容 `<url>` 与 `url "title"` 两种写法。
	const trimmed = rawDestination.trim();
	if (!trimmed) {
		return null;
	}

	let remainder = "";
	let url = "";

	if (trimmed.startsWith("<")) {
		const closingBracket = trimmed.indexOf(">");
		if (closingBracket === -1) {
			return null;
		}

		url = trimmed.slice(1, closingBracket).trim();
		remainder = trimmed.slice(closingBracket + 1).trim();
	} else {
		const split = splitDestinationAndTitle(trimmed);
		url = split.url;
		remainder = split.remainder;
	}

	if (!isRemoteUrl(url)) {
		return null;
	}

	if (!remainder) {
		return { title: null, url };
	}

	const title = parseQuotedTitle(remainder);
	if (title === null) {
		return null;
	}

	return {
		title,
		url,
	};
}

function splitDestinationAndTitle(value: string): { remainder: string; url: string } {
	// 切分 URL 和 title 时，需要忽略 URL 内部嵌套括号。
	let nestedParens = 0;

	for (let index = 0; index < value.length; index += 1) {
		const current = value.charAt(index);
		if (current === "\\") {
			index += 1;
			continue;
		}

		if (current === "(") {
			nestedParens += 1;
			continue;
		}

		if (current === ")" && nestedParens > 0) {
			nestedParens -= 1;
			continue;
		}

		if (nestedParens === 0 && /\s/.test(current)) {
			return {
				url: value.slice(0, index),
				remainder: value.slice(index).trim(),
			};
		}
	}

	return { url: value, remainder: "" };
}

function parseQuotedTitle(value: string): string | null {
	const quote = value.charAt(0);
	if ((quote !== '"' && quote !== "'") || value.charAt(value.length - 1) !== quote) {
		return null;
	}

	return unescapeMarkdownText(value.slice(1, -1));
}

function findMatchingDelimiter(
	text: string,
	startOffset: number,
	openDelimiter: string,
	closeDelimiter: string,
): number | null {
	// 通用括号匹配器，支持嵌套和转义。
	let depth = 0;

	for (let index = startOffset; index < text.length; index += 1) {
		const current = text.charAt(index);
		if (current === "\\") {
			index += 1;
			continue;
		}

		if (current === openDelimiter) {
			depth += 1;
			continue;
		}

		if (current === closeDelimiter) {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}

	return null;
}

function detectMediaKind(url: string): MediaKind | null {
	try {
		// 仅根据 URL 后缀推断媒体类型；没有后缀时不做转换。
		const pathname = new URL(url).pathname.toLowerCase();
		const extensionStart = pathname.lastIndexOf(".");
		if (extensionStart === -1) {
			return null;
		}

		const extension = pathname.slice(extensionStart);
		if (IMAGE_EXTENSIONS.has(extension)) {
			return "image";
		}

		if (AUDIO_EXTENSIONS.has(extension)) {
			return "audio";
		}

		if (VIDEO_EXTENSIONS.has(extension)) {
			return "video";
		}
	} catch {
		return null;
	}

	return null;
}

function renderMediaHtml(kind: MediaKind, embed: ParsedMediaEmbed): string {
	const escapedAlt = escapeHtmlText(embed.alt);
	const escapedSource = escapeHtmlAttribute(embed.url);
	const titleAttribute = embed.title
		? ` title="${escapeHtmlAttribute(embed.title)}"`
		: "";

	// 直接输出 HTML，避免依赖 Anki 端再跑一遍 Markdown 解析。
	if (kind === "image") {
		return `<img src="${escapedSource}" alt="${escapeHtmlAttribute(embed.alt)}"${titleAttribute} style="max-width: 100%; height: auto;">`;
	}

	if (kind === "audio") {
		return `<audio controls preload="metadata"${titleAttribute} src="${escapedSource}">${escapedAlt || "Audio playback is not supported."}</audio>`;
	}

	return `<video controls preload="metadata" playsinline${titleAttribute} src="${escapedSource}" style="max-width: 100%; height: auto;">${escapedAlt || "Video playback is not supported."}</video>`;
}

function isRemoteUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function unescapeMarkdownText(value: string): string {
	return value.replace(/\\([()[\]\\"])/g, "$1");
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "&#39;");
}

function escapeHtmlText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
