import { Editor, Notice, Plugin } from "obsidian";

type CardMarkerKind = "card-start" | "card-back" | "card-end";
type CardMarkerState = "idle" | "front-open" | "back-open";

const CARD_TEMPLATE = [
	"<!-- card-start -->",
	"Front",
	"<!-- card-back -->",
	"Back",
	"<!-- card-end -->",
].join("\n");

const CARD_MARKERS: Record<CardMarkerKind, string> = {
	"card-start": "<!-- card-start -->",
	"card-back": "<!-- card-back -->",
	"card-end": "<!-- card-end -->",
};

const CARD_MARKER_SCAN_PATTERN =
	/^\s*<!--\s*(card-start|card-back|card-end)\b.*?-->\s*$/gm;
const CARD_MARKER_LINE_PATTERN =
	/^\s*<!--\s*card-(?:start|back|end)\b.*?-->\s*$/;
const LINE_BREAK_PATTERN = /\r?\n/;

export function registerEditorCommands(plugin: Plugin): void {
	plugin.addCommand({
		id: "make-card",
		name: "Make card",
		editorCallback: (editor: Editor) => {
			insertNextCardMarker(editor);
		},
	});

	plugin.addCommand({
		id: "delete-card",
		name: "Delete card",
		editorCheckCallback: (checking, editor: Editor) => {
			if (!editor.somethingSelected()) {
				return false;
			}

			if (!checking) {
				removeCardMarkersFromSelection(editor);
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "insert-card-template",
		name: "Insert card template",
		editorCallback: (editor: Editor) => {
			editor.replaceSelection(CARD_TEMPLATE);
		},
	});
}

function insertNextCardMarker(editor: Editor): void {
	const cursor = editor.getCursor("head");
	const documentText = editor.getValue();
	const cursorOffset = editor.posToOffset(cursor);
	const marker = CARD_MARKERS[getNextCardMarkerKind(documentText.slice(0, cursorOffset))];
	const insertion = buildMarkerInsertion(documentText, cursorOffset, marker);

	editor.replaceRange(insertion, cursor);
	editor.setCursor(editor.offsetToPos(cursorOffset + insertion.length));
}

function removeCardMarkersFromSelection(editor: Editor): void {
	const selection = editor.getSelection();
	const strippedSelection = stripCardMarkers(selection);

	if (selection === strippedSelection) {
		new Notice("No card markers found in the selected text.");
		return;
	}

	editor.replaceSelection(strippedSelection);
}

function getNextCardMarkerKind(textBeforeCursor: string): CardMarkerKind {
	let state: CardMarkerState = "idle";
	let match: RegExpExecArray | null;

	CARD_MARKER_SCAN_PATTERN.lastIndex = 0;
	match = CARD_MARKER_SCAN_PATTERN.exec(textBeforeCursor);

	while (match) {
		const kind = match[1];

		if (kind === "card-start") {
			state = "front-open";
		} else if (kind === "card-back") {
			if (state === "front-open") {
				state = "back-open";
			}
		} else if (kind === "card-end") {
			state = "idle";
		}

		match = CARD_MARKER_SCAN_PATTERN.exec(textBeforeCursor);
	}

	if (state === "front-open") {
		return "card-back";
	}

	if (state === "back-open") {
		return "card-end";
	}

	return "card-start";
}

function buildMarkerInsertion(
	documentText: string,
	offset: number,
	marker: string,
): string {
	const previousCharacter = offset > 0 ? documentText.charAt(offset - 1) : "";
	const nextCharacter = offset < documentText.length ? documentText.charAt(offset) : "";
	const prefix = offset > 0 && !isLineBreak(previousCharacter) ? "\n" : "";
	const suffix =
		offset === documentText.length || !isLineBreak(nextCharacter) ? "\n" : "";

	return `${prefix}${marker}${suffix}`;
}

function stripCardMarkers(text: string): string {
	return text
		.split(LINE_BREAK_PATTERN)
		.filter((line) => !CARD_MARKER_LINE_PATTERN.test(line))
		.join("\n");
}

function isLineBreak(character: string): boolean {
	return character === "\n" || character === "\r";
}
