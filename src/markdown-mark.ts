import type MarkdownIt from "markdown-it";

const MARK_TOKEN = "obak_mark_inline";
const MARK_DELIMITER = "==";

const markdownMarkPlugin: MarkdownIt.PluginSimple = (renderer) => {
	// 放在数学规则之后，避免和 `$...$` 解析链路互相打断。
	renderer.inline.ruler.after("obak_math_inline", MARK_TOKEN, parseMarkInline);

	renderer.renderer.rules[MARK_TOKEN] = (tokens, index, _options, env) => {
		const token = tokens[index];
		if (!token) {
			return "";
		}

		return `<mark>${renderer.renderInline(token.content, env)}</mark>`;
	};
};

export default markdownMarkPlugin;

function parseMarkInline(
	state: MarkdownIt.StateInline,
	silent: boolean,
): boolean {
	// 仅支持单行 `==高亮==`，并要求分隔符未被转义。
	const start = state.pos;
	if (!state.src.startsWith(MARK_DELIMITER, start) || isEscaped(state.src, start)) {
		return false;
	}

	if (state.src.charAt(start + MARK_DELIMITER.length) === "=") {
		return false;
	}

	const closingIndex = findClosingMarkDelimiter(
		state.src,
		start + MARK_DELIMITER.length,
	);
	if (closingIndex === -1) {
		return false;
	}

	const content = state.src.slice(
		start + MARK_DELIMITER.length,
		closingIndex,
	);
	if (!content.trim() || content.includes("\n")) {
		return false;
	}

	if (!silent) {
		const token = state.push(MARK_TOKEN, "", 0);
		token.content = content;
		token.markup = MARK_DELIMITER;
	}

	state.pos = closingIndex + MARK_DELIMITER.length;
	return true;
}

function findClosingMarkDelimiter(text: string, startIndex: number): number {
	// 避免把 `===` 这类连续等号的一部分误判为闭合标记。
	for (let index = startIndex; index < text.length - 1; index += 1) {
		if (!text.startsWith(MARK_DELIMITER, index) || isEscaped(text, index)) {
			continue;
		}

		if (text.charAt(index - 1) === "=" || text.charAt(index + 2) === "=") {
			continue;
		}

		return index;
	}

	return -1;
}

function isEscaped(text: string, index: number): boolean {
	let slashCount = 0;
	let cursor = index - 1;

	while (cursor >= 0 && text.charAt(cursor) === "\\") {
		slashCount += 1;
		cursor -= 1;
	}

	return slashCount % 2 === 1;
}
