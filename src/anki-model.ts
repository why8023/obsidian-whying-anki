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

export interface ObakStoredCardTemplate {
	Back: string;
	Front: string;
}

export const OBAK_CARD_TEMPLATES: ObakCardTemplate[] = [
	{
		Name: "Card 1",
		Front: '<div class="obak-markdown obak-front">{{Front}}</div>',
		Back: [
			"{{FrontSide}}",
			"",
			"<hr id=answer>",
			"",
			'<div class="obak-markdown obak-back">{{Back}}</div>',
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
	"\tline-height: 1.5;",
	"\tcolor: black;",
	"\tbackground-color: white;",
	"}",
	"",
	".obak-markdown {",
	"\tdisplay: inline-block;",
	"\tmax-width: 100%;",
	"\ttext-align: left;",
	"}",
	"",
	".obak-markdown > :first-child {",
	"\tmargin-top: 0;",
	"}",
	"",
	".obak-markdown > :last-child {",
	"\tmargin-bottom: 0;",
	"}",
	"",
	".obak-markdown p,",
	".obak-markdown ul,",
	".obak-markdown ol,",
	".obak-markdown blockquote,",
	".obak-markdown pre,",
	".obak-markdown h1,",
	".obak-markdown h2,",
	".obak-markdown h3,",
	".obak-markdown h4,",
	".obak-markdown h5,",
	".obak-markdown h6 {",
	"\tmargin: 0 0 0.75em;",
	"}",
	"",
	".obak-markdown ul,",
	".obak-markdown ol {",
	"\tpadding-left: 1.5em;",
	"}",
	"",
	".obak-markdown blockquote {",
	"\tmargin-left: 0;",
	"\tpadding-left: 0.9em;",
	"\tborder-left: 0.2em solid #c8c8c8;",
	"\tcolor: #555;",
	"}",
	"",
	".obak-markdown code {",
	"\tpadding: 0.1em 0.3em;",
	"\tborder-radius: 0.25em;",
	"\tbackground: #f2f2f2;",
	"\tfont-family: Consolas, 'Courier New', monospace;",
	"\tfont-size: 0.9em;",
	"}",
	"",
	".obak-markdown pre {",
	"\toverflow-x: auto;",
	"\tpadding: 0.75em 0.9em;",
	"\tborder-radius: 0.4em;",
	"\tbackground: #f5f5f5;",
	"}",
	"",
	".obak-markdown pre code {",
	"\tpadding: 0;",
	"\tborder-radius: 0;",
	"\tbackground: transparent;",
	"}",
	"",
	".obak-markdown a {",
	"\tcolor: #0b63ce;",
	"}",
	"",
	".obak-markdown img,",
	".obak-markdown video {",
	"\tmax-width: 100%;",
	"\theight: auto;",
	"}",
	"",
	".obak-markdown audio {",
	"\tmax-width: 100%;",
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

export function buildObakTemplateMap(): Record<string, ObakStoredCardTemplate> {
	return Object.fromEntries(
		OBAK_CARD_TEMPLATES.map((template) => [
			template.Name,
			{
				Front: template.Front,
				Back: template.Back,
			},
		]),
	);
}
