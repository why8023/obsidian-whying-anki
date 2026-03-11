/**
 * 构造指向 Obsidian 文件的 `obsidian://open` URI。
 */
export function buildObsidianFileUri(vaultName: string, filePath: string): string {
	return `obsidian://open?vault=${encodeURIComponent(
		vaultName,
	)}&file=${encodeURIComponent(filePath)}`;
}

/**
 * 生成在 Anki 中展示的“返回 Obsidian”链接 HTML。
 */
export function buildObsidianLinkHtml(obUri: string): string {
	return `<p><a href="${obUri}">Open in Obsidian</a></p>`;
}

/**
 * 在已有 HTML 正文后追加 Obsidian 回链。
 */
export function appendObsidianLink(body: string, obUri: string): string {
	const trimmedBody = body.trim();
	const linkHtml = buildObsidianLinkHtml(obUri);

	return trimmedBody ? `${trimmedBody}\n\n${linkHtml}` : linkHtml;
}
