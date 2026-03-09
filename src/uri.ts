export function buildObsidianFileUri(vaultName: string, filePath: string): string {
	return `obsidian://open?vault=${encodeURIComponent(
		vaultName,
	)}&file=${encodeURIComponent(filePath)}`;
}

export function buildObsidianLinkHtml(obUri: string): string {
	return `<p><a href="${obUri}">Open in Obsidian</a></p>`;
}

export function appendObsidianLink(body: string, obUri: string): string {
	const trimmedBody = body.trim();
	const linkHtml = buildObsidianLinkHtml(obUri);

	return trimmedBody ? `${trimmedBody}\n\n${linkHtml}` : linkHtml;
}
