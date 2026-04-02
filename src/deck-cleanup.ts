export function collectDescendantDeckNames(
	rootDeck: string,
	deckNames: Iterable<string>,
): string[] {
	const normalizedRootDeck = normalizeDeckName(rootDeck);
	if (!normalizedRootDeck) {
		return [];
	}

	const descendantDeckNames = new Set<string>();
	const rootPrefix = `${normalizedRootDeck}::`;

	for (const deckName of deckNames) {
		const normalizedDeckName = normalizeDeckName(deckName);
		if (!normalizedDeckName || normalizedDeckName === normalizedRootDeck) {
			continue;
		}

		if (normalizedDeckName.startsWith(rootPrefix)) {
			descendantDeckNames.add(normalizedDeckName);
		}
	}

	return [...descendantDeckNames].sort(compareDeckNamesByDepthDescThenName);
}

export function hasRemainingDescendantDeck(
	deckName: string,
	deckNames: Iterable<string>,
): boolean {
	const descendantPrefix = `${deckName}::`;

	for (const candidateDeckName of deckNames) {
		if (candidateDeckName !== deckName && candidateDeckName.startsWith(descendantPrefix)) {
			return true;
		}
	}

	return false;
}

function compareDeckNamesByDepthDescThenName(left: string, right: string): number {
	const depthDifference = getDeckDepth(right) - getDeckDepth(left);
	return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
}

function getDeckDepth(deckName: string): number {
	return deckName.split("::").length;
}

function normalizeDeckName(value: string): string {
	return value.trim();
}
