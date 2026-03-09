export function buildObsidianFileUri(vaultName: string, filePath: string): string {
	return `obsidian://open?vault=${encodeURIComponent(
		vaultName,
	)}&file=${encodeURIComponent(filePath)}`;
}
