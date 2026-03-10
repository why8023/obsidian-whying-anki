import { normalizeCardBody } from "./normalize";
import type {
	CardEndMeta,
	CardStartMeta,
	ParseError,
	ParsedCardBlock,
} from "./types";

type MarkerKind = "card-start" | "card-back" | "card-end";

type MarkerParseResult =
	| { matched: false }
	| { matched: true; error: ParseError }
	| {
			matched: true;
			kind: MarkerKind;
			startMeta?: CardStartMeta;
			endMeta?: CardEndMeta;
	  };

interface LineEntry {
	lineNumber: number;
	text: string;
	startOffset: number;
	endOffset: number;
}

interface CardParseState {
	startLine: number;
	startMeta: CardStartMeta;
	frontLines: string[];
	backLines: string[];
	backLine: number | null;
}

const MARKER_PATTERN = /^<!--\s*(card-start|card-back|card-end)(.*?)-->$/;
const ATTRIBUTE_PATTERN = /\s+([A-Za-z][\w-]*)="([^"]*)"/gy;
const START_ATTRIBUTES = new Set(["deck", "tags"]);
const END_ATTRIBUTES = new Set(["uid", "id", "rev"]);

export function parseCardsFromMarkdown(
	text: string,
	filePath: string,
): { cards: ParsedCardBlock[]; errors: ParseError[] } {
	const cards: ParsedCardBlock[] = [];
	const errors: ParseError[] = [];
	const lines = getLineEntries(text);
	let current: CardParseState | null = null;

	for (const line of lines) {
		const marker = parseMarkerLine(line.text.trim(), filePath, line.lineNumber);

		if (!marker.matched) {
			if (current) {
				const bucket = current.backLine === null ? current.frontLines : current.backLines;
				bucket.push(line.text);
			}
			continue;
		}

		if ("error" in marker) {
			errors.push(marker.error);
			continue;
		}

		if (marker.kind === "card-start") {
			if (current) {
				errors.push(
					createParseError(
						filePath,
						line.lineNumber,
						"Nested card-start markers are not allowed.",
					),
				);
			}

			current = {
				startLine: line.lineNumber,
				startMeta: marker.startMeta ?? { tags: [] },
				frontLines: [],
				backLines: [],
				backLine: null,
			};
			continue;
		}

		if (marker.kind === "card-back") {
			if (!current) {
				errors.push(
					createParseError(
						filePath,
						line.lineNumber,
						"card-back must appear after card-start.",
					),
				);
				continue;
			}

			if (current.backLine !== null) {
				errors.push(
					createParseError(
						filePath,
						line.lineNumber,
						"Only one card-back marker is allowed per card.",
					),
				);
				continue;
			}

			current.backLine = line.lineNumber;
			continue;
		}

		if (!current) {
			errors.push(
				createParseError(
					filePath,
					line.lineNumber,
					"card-end must appear after card-start and card-back.",
				),
			);
			continue;
		}

		if (current.backLine === null) {
			errors.push(
				createParseError(
					filePath,
					line.lineNumber,
					"card-end cannot appear before card-back.",
				),
			);
			current = null;
			continue;
		}

		const frontRaw = current.frontLines.join("\n");
		const backRaw = current.backLines.join("\n");

		if (!normalizeCardBody(frontRaw) && !normalizeCardBody(backRaw)) {
			errors.push(
				createParseError(
					filePath,
					current.startLine,
					"Card front and back cannot both be empty.",
				),
			);
			current = null;
			continue;
		}

		cards.push({
			filePath,
			startLine: current.startLine,
			backLine: current.backLine,
			endLine: line.lineNumber,
			endMarkerStartOffset: line.startOffset,
			endMarkerEndOffset: line.endOffset,
			originalEndMarker: line.text.trim(),
			frontRaw,
			backRaw,
			startMeta: current.startMeta,
			endMeta: marker.endMeta ?? { uid: null, noteId: null, rev: null },
		});
		current = null;
	}

	if (current) {
		errors.push(
			createParseError(
				filePath,
				current.startLine,
				current.backLine === null
					? "Missing card-back before card-end."
					: "Missing card-end marker.",
			),
		);
	}

	return { cards, errors };
}

export function serializeCardEnd(meta: CardEndMeta): string {
	const attributes = [
		meta.uid ? `uid="${meta.uid}"` : null,
		meta.noteId ? `id="${meta.noteId}"` : null,
		meta.rev ? `rev="${meta.rev}"` : null,
	].filter((value): value is string => value !== null);

	return attributes.length > 0
		? `<!-- card-end ${attributes.join(" ")} -->`
		: "<!-- card-end -->";
}

function parseMarkerLine(
	line: string,
	filePath: string,
	lineNumber: number,
): MarkerParseResult {
	const match = MARKER_PATTERN.exec(line);
	if (!match) {
		return { matched: false };
	}

	const kind = match[1] as MarkerKind;
	const rawAttributes = match[2] ?? "";

	if (kind === "card-back") {
		if (rawAttributes.trim()) {
			return {
				matched: true,
				error: createParseError(
					filePath,
					lineNumber,
					"card-back does not accept any attributes.",
				),
			};
		}

		return { matched: true, kind };
	}

	const attributeResult = parseAttributes(
		rawAttributes,
		kind === "card-start" ? START_ATTRIBUTES : END_ATTRIBUTES,
		filePath,
		lineNumber,
	);
	if ("error" in attributeResult) {
		return { matched: true, error: attributeResult.error };
	}

	if (kind === "card-start") {
		return {
			matched: true,
			kind,
			startMeta: {
				deck: attributeResult.values.deck?.trim() || undefined,
				tags: attributeResult.values.tags
					? attributeResult.values.tags
							.split(",")
							.map((tag) => tag.trim())
							.filter(Boolean)
					: [],
			},
		};
	}

	return {
		matched: true,
		kind,
		endMeta: {
			uid: attributeResult.values.uid ?? null,
			noteId: attributeResult.values.id ?? null,
			rev: attributeResult.values.rev ?? null,
		},
	};
}

function parseAttributes(
	rawAttributes: string,
	allowedAttributes: Set<string>,
	filePath: string,
	lineNumber: number,
): { values: Record<string, string> } | { error: ParseError } {
	const values: Record<string, string> = {};
	const attributes = rawAttributes.trimEnd();
	let cursor = 0;

	while (cursor < attributes.length) {
		ATTRIBUTE_PATTERN.lastIndex = cursor;
		const match = ATTRIBUTE_PATTERN.exec(attributes);

		if (!match) {
			return {
				error: createParseError(
					filePath,
					lineNumber,
					"Failed to parse marker attributes.",
				),
			};
		}

		const key = match[1];
		const value = match[2];
		if (key === undefined || value === undefined) {
			return {
				error: createParseError(
					filePath,
					lineNumber,
					"Failed to parse marker attributes.",
				),
			};
		}

		if (!allowedAttributes.has(key)) {
			return {
				error: createParseError(
					filePath,
					lineNumber,
					`Unsupported attribute "${key}".`,
				),
			};
		}

		if (Object.prototype.hasOwnProperty.call(values, key)) {
			return {
				error: createParseError(
					filePath,
					lineNumber,
					`Duplicate attribute "${key}".`,
				),
			};
		}

		if (value.includes("-->")) {
			return {
				error: createParseError(
					filePath,
					lineNumber,
					`Attribute "${key}" cannot contain "-->".`,
				),
			};
		}

		values[key] = value;
		cursor = ATTRIBUTE_PATTERN.lastIndex;
	}

	return { values };
}

function getLineEntries(text: string): LineEntry[] {
	if (!text) {
		return [];
	}

	const entries: LineEntry[] = [];
	let start = 0;
	let lineNumber = 1;

	while (start < text.length) {
		const newlineOffset = text.indexOf("\n", start);
		const lineEnd = newlineOffset === -1 ? text.length : newlineOffset;
		const contentEnd =
			lineEnd > start && text.charAt(lineEnd - 1) === "\r" ? lineEnd - 1 : lineEnd;

		entries.push({
			lineNumber,
			text: text.slice(start, contentEnd),
			startOffset: start,
			endOffset: contentEnd,
		});

		if (newlineOffset === -1) {
			break;
		}

		start = newlineOffset + 1;
		lineNumber += 1;
	}

	return entries;
}

function createParseError(
	filePath: string,
	line: number,
	message: string,
): ParseError {
	return {
		filePath,
		line,
		message,
	};
}
