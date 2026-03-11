import type MarkdownIt from "markdown-it";

// 自定义 token 名称，用于把数学公式插入 markdown-it 的解析结果。
const BLOCK_MATH_TOKEN = "obak_math_block";
const DISPLAY_MATH_INLINE_TOKEN = "obak_math_display_inline";
const INLINE_MATH_TOKEN = "obak_math_inline";

const DOLLAR_SIGN = "$";

const SINGLE_DOLLAR = 1;
const DOUBLE_DOLLAR = 2;

const WHITESPACE_PATTERN = /\s/;

const markdownMathPlugin: MarkdownIt.PluginSimple = (renderer) => {
	// 在 fence 之前识别块级公式，在 backticks 之后识别行内公式，尽量降低规则冲突。
	renderer.block.ruler.before("fence", "obak_math_block", parseMathBlock);
	renderer.inline.ruler.after("backticks", "obak_math_inline", parseMathInline);

	renderer.renderer.rules[BLOCK_MATH_TOKEN] = (tokens, index) => {
		const token = tokens[index];
		if (!token) {
			return "";
		}

		return renderDisplayMath(token.content, false);
	};

	renderer.renderer.rules[DISPLAY_MATH_INLINE_TOKEN] = (tokens, index) => {
		const token = tokens[index];
		if (!token) {
			return "";
		}

		return renderDisplayMath(token.content, true);
	};

	renderer.renderer.rules[INLINE_MATH_TOKEN] = (tokens, index) => {
		const token = tokens[index];
		if (!token) {
			return "";
		}

		return renderInlineMath(token.content);
	};
};

export default markdownMathPlugin;

function parseMathBlock(
	state: MarkdownIt.StateBlock,
	startLine: number,
	endLine: number,
	silent: boolean,
): boolean {
	// 支持单行 `$$x$$` 和多行包围式：
	// $$
	// x
	// $$
	const lineStartOffset = state.bMarks[startLine];
	const lineShift = state.tShift[startLine];
	const lineEnd = state.eMarks[startLine];
	if (lineStartOffset === undefined || lineShift === undefined || lineEnd === undefined) {
		return false;
	}

	const lineStart = lineStartOffset + lineShift;
	const trimmedLine = state.src.slice(lineStart, lineEnd).trim();

	if (!trimmedLine.startsWith("$$")) {
		return false;
	}

	const singleLineContent = getSingleLineBlockMathContent(trimmedLine);
	if (singleLineContent !== null) {
		if (silent) {
			return true;
		}

		pushMathBlockToken(state, singleLineContent, startLine, startLine + 1);
		state.line = startLine + 1;
		return true;
	}

	if (trimmedLine !== "$$") {
		return false;
	}

	const contentLines: string[] = [];
	let nextLine = startLine + 1;

	while (nextLine < endLine) {
		const nextStartOffset = state.bMarks[nextLine];
		const nextShift = state.tShift[nextLine];
		const nextEnd = state.eMarks[nextLine];
		if (
			nextStartOffset === undefined ||
			nextShift === undefined ||
			nextEnd === undefined
		) {
			return false;
		}

		const nextStart = nextStartOffset + nextShift;
		const trimmedNextLine = state.src.slice(nextStart, nextEnd).trim();
		if (trimmedNextLine === "$$") {
			if (silent) {
				return true;
			}

			const content = contentLines.join("\n").trim();
			if (!content) {
				return false;
			}

			pushMathBlockToken(state, content, startLine, nextLine + 1);
			state.line = nextLine + 1;
			return true;
		}

		contentLines.push(state.src.slice(nextStart, nextEnd));
		nextLine += 1;
	}

	return false;
}

function parseMathInline(
	state: MarkdownIt.StateInline,
	silent: boolean,
): boolean {
	// 行内支持 `$...$` 与 `$$...$$`；单美元会做更严格的误判规避。
	const start = state.pos;
	if (state.src.charAt(start) !== DOLLAR_SIGN || isEscaped(state.src, start)) {
		return false;
	}

	const delimiterLength =
		state.src.charAt(start + 1) === DOLLAR_SIGN ? DOUBLE_DOLLAR : SINGLE_DOLLAR;
	if (!canOpenMathDelimiter(state.src, start, delimiterLength)) {
		return false;
	}

	const closingIndex = findClosingMathDelimiter(
		state.src,
		start + delimiterLength,
		delimiterLength,
	);
	if (closingIndex === -1) {
		return false;
	}

	const rawContent = state.src.slice(start + delimiterLength, closingIndex);
	if (delimiterLength === SINGLE_DOLLAR && rawContent.includes("\n")) {
		return false;
	}

	const content = rawContent.trim();
	if (!content) {
		return false;
	}

	if (!silent) {
		const token = state.push(
			delimiterLength === DOUBLE_DOLLAR
				? DISPLAY_MATH_INLINE_TOKEN
				: INLINE_MATH_TOKEN,
			"",
			0,
		);
		token.content = content;
	}

	state.pos = closingIndex + delimiterLength;
	return true;
}

function pushMathBlockToken(
	state: MarkdownIt.StateBlock,
	content: string,
	startLine: number,
	endLine: number,
): void {
	// 真正输出 HTML 的工作交给 renderer.rules，这里只负责压入 token。
	const token = state.push(BLOCK_MATH_TOKEN, "", 0);
	token.block = true;
	token.content = content;
	token.map = [startLine, endLine];
	token.markup = "$$";
}

function getSingleLineBlockMathContent(line: string): string | null {
	if (!line.startsWith("$$") || !line.endsWith("$$")) {
		return null;
	}

	if (line.length < 4 || line === "$$") {
		return null;
	}

	const content = line.slice(2, -2).trim();
	return content ? content : null;
}

function canOpenMathDelimiter(
	text: string,
	index: number,
	delimiterLength: number,
): boolean {
	// 单美元起始条件更严格，避免把金额或普通符号误识别成公式。
	const nextCharacter = text.charAt(index + delimiterLength);
	if (!nextCharacter) {
		return false;
	}

	if (delimiterLength === SINGLE_DOLLAR) {
		if (WHITESPACE_PATTERN.test(nextCharacter) || nextCharacter === DOLLAR_SIGN) {
			return false;
		}

		const previousCharacter = index > 0 ? text.charAt(index - 1) : "";
		if (/\d/.test(previousCharacter)) {
			return false;
		}
	}

	return true;
}

function findClosingMathDelimiter(
	text: string,
	startIndex: number,
	delimiterLength: number,
): number {
	// 单美元闭合时避开空白、连续美元和数字相邻等高误判场景。
	for (let index = startIndex; index < text.length; index += 1) {
		if (text.charAt(index) !== DOLLAR_SIGN || isEscaped(text, index)) {
			continue;
		}

		if (delimiterLength === DOUBLE_DOLLAR) {
			if (text.charAt(index + 1) === DOLLAR_SIGN && !isEscaped(text, index + 1)) {
				return index;
			}
			continue;
		}

		const previousCharacter = text.charAt(index - 1);
		const nextCharacter = text.charAt(index + 1);
		if (
			previousCharacter &&
			WHITESPACE_PATTERN.test(previousCharacter)
		) {
			continue;
		}

		if (nextCharacter === DOLLAR_SIGN || /\d/.test(nextCharacter)) {
			continue;
		}

		return index;
	}

	return -1;
}

function isEscaped(text: string, index: number): boolean {
	// 根据前导反斜杠数量判断当前美元符号是否被转义。
	let slashCount = 0;
	let cursor = index - 1;

	while (cursor >= 0 && text.charAt(cursor) === "\\") {
		slashCount += 1;
		cursor -= 1;
	}

	return slashCount % 2 === 1;
}

function renderInlineMath(content: string): string {
	// 输出 `\(...\)` / `\[...\]` 包裹格式，交给 Anki 端的数学渲染器处理。
	return `<span class="obak-inline-math">\\(${escapeHtml(content)}\\)</span>`;
}

function renderDisplayMath(content: string, inline: boolean): string {
	const tagName = inline ? "span" : "div";
	const className = inline
		? "obak-display-math obak-display-math-inline"
		: "obak-display-math";

	return `<${tagName} class="${className}">\\[${escapeHtml(content)}\\]</${tagName}>`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
