// 插件在 Anki 中使用的固定模型名。
export const OBAK_MODEL_NAME = "OBAK Basic";

// 字段顺序必须稳定；Anki 模型一旦创建，字段顺序变化会破坏兼容性。
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

/**
 * 生成 Anki 字段值时所需的原始输入。
 */
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

/**
 * 创建或更新一条 Obak 笔记时的完整输入。
 */
export interface ObakNoteInput {
	deckName: string;
	fields: ObakFieldInput;
	tags: string[];
}

// 这两个接口分别对应“创建模型时提交的模板结构”和“从 Anki 读取回来的模板结构”。
export interface ObakCardTemplate {
	Back: string;
	Front: string;
	Name: string;
}

export interface ObakStoredCardTemplate {
	Back: string;
	Front: string;
}

// 当前只定义一张基础卡片模板；以后如果要支持更多模板，可在这里追加。
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

// 模型 CSS 直接内置在代码中，首次同步即可自动创建或修正 Anki 端样式。
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
	".obak-markdown table,",
	".obak-markdown blockquote,",
	".obak-markdown pre,",
	".obak-markdown hr,",
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
	".obak-markdown hr {",
	"\tborder: 0;",
	"\tborder-top: 1px solid #d8d8d8;",
	"}",
	"",
	".obak-markdown table {",
	"\tborder-collapse: collapse;",
	"\tmin-width: 16rem;",
	"\tmax-width: 100%;",
	"}",
	"",
	".obak-markdown th,",
	".obak-markdown td {",
	"\tpadding: 0.35em 0.6em;",
	"\tborder: 1px solid #d9d9d9;",
	"}",
	"",
	".obak-markdown th {",
	"\tbackground: #f3f3f3;",
	"\tfont-weight: 600;",
	"}",
	"",
	".obak-markdown blockquote {",
	"\tmargin-left: 0;",
	"\tpadding-left: 0.9em;",
	"\tborder-left: 0.2em solid #c8c8c8;",
	"\tcolor: #555;",
	"}",
	"",
	".obak-markdown mark {",
	"\tpadding: 0.08em 0.2em;",
	"\tbackground: #fff2a8;",
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
	".obak-markdown .contains-task-list {",
	"\tpadding-left: 0;",
	"}",
	"",
	".obak-markdown .task-list-item {",
	"\tlist-style: none;",
	"}",
	"",
	".obak-markdown .task-list-item-checkbox {",
	"\tmargin-right: 0.55em;",
	"\tpointer-events: none;",
	"}",
	"",
	".obak-inline-math,",
	".obak-display-math {",
	"\toverflow-x: auto;",
	"}",
	"",
	".obak-display-math {",
	"\tdisplay: block;",
	"\ttext-align: center;",
	"}",
	"",
	".obak-display-math-inline {",
	"\tmargin: 0.5em 0;",
	"}",
	"",
	".obsidian-source {",
	"\tmargin-top: 1.25rem;",
	"\tfont-size: 0.8em;",
	"\tcolor: #666;",
	"}",
].join("\n");

/**
 * 把插件内部字段映射成 Anki 模型的实际字段名和值。
 */
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
	// 模型里保留一份逗号分隔的标签文本，便于在 Anki 内部直接查看。
	return tags.map((tag) => tag.trim()).filter(Boolean).join(", ");
}

/**
 * 构造以模板名为键的映射，便于与 Anki 当前模板进行对比。
 */
export function buildObakTemplateMap(): Record<string, ObakStoredCardTemplate> {
	const templates: Record<string, ObakStoredCardTemplate> = {};

	for (const template of OBAK_CARD_TEMPLATES) {
		templates[template.Name] = {
			Front: template.Front,
			Back: template.Back,
		};
	}

	return templates;
}
