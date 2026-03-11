import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import markdownMarkPlugin from "./markdown-mark";
import markdownMathPlugin from "./markdown-math";
import { renderMarkdownMediaForAnki } from "./markdown-media";

// 渲染器做成单例，避免每次扫描卡片都重新初始化 markdown-it。
const MARKDOWN_RENDERER = createMarkdownRenderer();

/**
 * 把卡片正文 Markdown 渲染成适合写入 Anki 字段的 HTML。
 */
export function renderMarkdownForAnki(text: string): string {
	if (!text) {
		return "";
	}

	return MARKDOWN_RENDERER.render(renderMarkdownMediaForAnki(text)).trim();
}

function createMarkdownRenderer(): MarkdownIt {
	// 这里定义“插件支持哪些 Markdown 语法进入 Anki”的总入口。
	const renderer = new MarkdownIt({
		breaks: true,
		html: true,
		linkify: true,
		typographer: false,
		highlight: renderFence,
	});

	// Keep local or unsupported embeds as literal text until media sync lands.
	renderer.disable("image");
	renderer.use(markdownMathPlugin);
	renderer.use(markdownMarkPlugin);
	renderer.use(markdownItTaskLists);

	return renderer;
}

function renderFence(code: string, language: string): string {
	// 不在这里依赖额外高亮库，只输出安全的 `<pre><code>`。
	const escapedCode = escapeHtml(code);
	const normalizedLanguage = language.trim();
	const className = normalizedLanguage
		? ` class="language-${escapeHtmlAttribute(normalizedLanguage)}"`
		: "";

	return `<pre><code${className}>${escapedCode}</code></pre>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
