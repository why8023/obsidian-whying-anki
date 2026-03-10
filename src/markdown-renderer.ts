import MarkdownIt from "markdown-it";
import markdownItTaskLists from "markdown-it-task-lists";
import markdownMarkPlugin from "./markdown-mark";
import markdownMathPlugin from "./markdown-math";
import { renderMarkdownMediaForAnki } from "./markdown-media";

const MARKDOWN_RENDERER = createMarkdownRenderer();

export function renderMarkdownForAnki(text: string): string {
	if (!text) {
		return "";
	}

	return MARKDOWN_RENDERER.render(renderMarkdownMediaForAnki(text)).trim();
}

function createMarkdownRenderer(): MarkdownIt {
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
