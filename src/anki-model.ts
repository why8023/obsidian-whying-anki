export const OBAK_MODEL_NAME = "OBAK Basic";

export const OBAK_MODEL_FIELDS = [
	"ObsidianUid",
	"AnkiDeck",
	"AnkiTags",
	"AnkiNoteId",
	"Front",
	"Back",
	"ObsidianUri",
	"ObsidianPath",
	"ObsidianRev",
] as const;

export type ObakModelFieldName =
	(typeof OBAK_MODEL_FIELDS)[number];

export interface ObakFieldInput {
	ankiDeck: string;
	ankiNoteId: string | null;
	ankiTags: string[];
	back: string;
	front: string;
	obsidianPath: string;
	obsidianRev: string | null;
	obsidianUid: string;
	obsidianUri: string;
}

export interface ObakNoteInput {
	deckName: string;
	fields: ObakFieldInput;
	tags: string[];
}

export interface ObakCardTemplate {
	Back: string;
	Front: string;
	Name: string;
}

export const OBAK_CARD_TEMPLATES: ObakCardTemplate[] = [
	{
		Name: "Card 1",
		Front: "{{Front}}",
		Back: [
			"{{FrontSide}}",
			"",
			"<hr id=answer>",
			"",
			"{{Back}}",
			"",
			"{{#ObsidianUri}}",
			'<div class="obsidian-source"><a href="{{ObsidianUri}}">Open in Obsidian</a></div>',
			"{{/ObsidianUri}}",
		].join("\n"),
	},
];

export const OBAK_MODEL_CSS = [
	".card {",
	"\tfont-family: arial;",
	"\tfont-size: 20px;",
	"\ttext-align: center;",
	"\tcolor: black;",
	"\tbackground-color: white;",
	"}",
	"",
	".obsidian-source {",
	"\tmargin-top: 1.25rem;",
	"\tfont-size: 0.8em;",
	"\tcolor: #666;",
	"}",
].join("\n");

export function buildObakFields(
	input: ObakFieldInput,
): Record<ObakModelFieldName, string> {
	return {
		ObsidianUid: input.obsidianUid.trim(),
		AnkiDeck: input.ankiDeck.trim(),
		AnkiTags: formatAnkiTagField(input.ankiTags),
		AnkiNoteId: input.ankiNoteId?.trim() ?? "",
		Front: input.front,
		Back: input.back,
		ObsidianUri: input.obsidianUri.trim(),
		ObsidianPath: input.obsidianPath.trim(),
		ObsidianRev: input.obsidianRev?.trim() ?? "",
	};
}

function formatAnkiTagField(tags: string[]): string {
	return tags.map((tag) => tag.trim()).filter(Boolean).join(", ");
}
