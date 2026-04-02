import { requestUrl } from "obsidian";
import {
	OBAK_CARD_TEMPLATES,
	OBAK_MODEL_CSS,
	OBAK_MODEL_FIELDS,
	OBAK_MODEL_NAME,
	buildObakFields,
	buildObakTemplateMap,
	type ObakModelFieldName,
	type ObakNoteInput,
	type ObakStoredCardTemplate,
} from "./anki-model";
import {
	collectDescendantDeckNames,
	hasRemainingDescendantDeck,
} from "./deck-cleanup";
import type { ObakSettings } from "./settings";

const ANKI_CONNECT_VERSION = 6;

export interface AnkiNoteInfo {
	noteId: string;
	modelName: string;
	tags: string[];
	cards: number[];
	fields: Record<string, string>;
}

interface AnkiConnectEnvelope<TResult> {
	result: TResult;
	error: string | null;
}

interface AnkiConnectMultiAction {
	action: string;
	version: number;
	params?: Record<string, unknown>;
}

export class AnkiConnectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnkiConnectError";
	}
}

export class AnkiClient {
	private readonly endpoint: string;
	private readonly autoCreateMissingDecks: boolean;

	constructor(
		settings: Pick<
			ObakSettings,
			"ankiHost" | "ankiPort" | "autoCreateMissingDecks"
		>,
	) {
		this.endpoint = `http://${settings.ankiHost}:${settings.ankiPort}`;
		this.autoCreateMissingDecks = settings.autoCreateMissingDecks;
	}

	async ensureReadyForSync(): Promise<void> {
		const version = await this.getVersion();
		if (version < ANKI_CONNECT_VERSION) {
			throw new AnkiConnectError(
				`AnkiConnect version ${version} is too old. Expected ${ANKI_CONNECT_VERSION}+ .`,
			);
		}

		await this.ensureObakModel();
	}

	async ensureDecksExist(deckNames: Iterable<string>): Promise<void> {
		if (!this.autoCreateMissingDecks) {
			return;
		}

		const normalizedDeckNames = [
			...new Set([...deckNames].map((deckName) => deckName.trim()).filter(Boolean)),
		];
		if (normalizedDeckNames.length === 0) {
			return;
		}

		const results = await this.call<Array<AnkiConnectEnvelope<number> | number[]>>("multi", {
			actions: normalizedDeckNames.map<AnkiConnectMultiAction>((deckName) => ({
				action: "createDeck",
				version: ANKI_CONNECT_VERSION,
				params: { deck: deckName },
			})),
		});

		const errors = results.flatMap((result, index) => {
			const unwrappedResult = unwrapMultiActionResult<number | number[]>(result);
			if (!unwrappedResult.error) {
				return [];
			}

			return [`${normalizedDeckNames[index]}: ${unwrappedResult.error}`];
		});

		if (errors.length > 0) {
			throw new AnkiConnectError(`AnkiConnect createDeck failed: ${errors.join("; ")}`);
		}
	}

	async addObakNote(input: ObakNoteInput): Promise<string> {
		const noteId = await this.call<number>("addNote", {
			note: buildObakNotePayload(input),
		});

		return String(noteId);
	}

	async updateObakNote(noteId: string, input: ObakNoteInput): Promise<void> {
		await this.call("updateNote", {
			note: {
				id: parseNumericNoteId(noteId),
				fields: buildObakFields(input.fields),
				tags: input.tags,
			},
		});
	}

	async changeDeck(cardIds: number[], deckName: string): Promise<void> {
		const normalizedCardIds = [...new Set(cardIds.filter((cardId) => Number.isInteger(cardId)))];
		if (normalizedCardIds.length === 0) {
			return;
		}

		await this.call("changeDeck", {
			cards: normalizedCardIds,
			deck: deckName,
		});
	}

	async cleanupEmptyDecksUnderRoot(rootDeck: string): Promise<string[]> {
		const deckNamesById = await this.getDeckNamesAndIds();
		const scopedDeckNames = collectDescendantDeckNames(
			rootDeck,
			Object.keys(deckNamesById),
		);
		if (scopedDeckNames.length === 0) {
			return [];
		}

		const remainingScopedDeckNames = new Set(scopedDeckNames);
		const deletedDeckNames: string[] = [];

		for (const deckName of scopedDeckNames) {
			if (
				!remainingScopedDeckNames.has(deckName) ||
				hasRemainingDescendantDeck(deckName, remainingScopedDeckNames)
			) {
				continue;
			}

			const cardIds = await this.findCards(
				`deck:"${escapeAnkiSearchTerm(deckName)}"`,
			);
			if (cardIds.length > 0) {
				continue;
			}

			await this.deleteDecks([deckName]);
			remainingScopedDeckNames.delete(deckName);
			deletedDeckNames.push(deckName);
		}

		return deletedDeckNames;
	}

	async findObakNoteIds(): Promise<string[]> {
		const noteIds = await this.call<number[]>("findNotes", {
			query: buildObakModelQuery(),
		});

		return normalizeNumericIds(noteIds);
	}

	async getNotesInfo(noteIds: string[]): Promise<Map<string, AnkiNoteInfo>> {
		const requestedIds = [
			...new Set(noteIds.map((noteId) => noteId.trim()).filter(Boolean)),
		]
			.map((noteId) => {
				const numericNoteId = Number.parseInt(noteId, 10);
				return Number.isInteger(numericNoteId) ? { noteId, numericNoteId } : null;
			})
			.filter(
				(
					entry,
				): entry is {
					noteId: string;
					numericNoteId: number;
				} => entry !== null,
			);

		if (requestedIds.length === 0) {
			return new Map();
		}

		const results = await this.call<unknown[]>("notesInfo", {
			notes: requestedIds.map((entry) => entry.numericNoteId),
		});
		const infoById = new Map<string, AnkiNoteInfo>();

		results.forEach((result, index) => {
			const entry = requestedIds[index];
			if (!entry) {
				return;
			}

			const noteInfo = parseAnkiNoteInfo(result);
			if (noteInfo) {
				infoById.set(entry.noteId, noteInfo);
			}
		});

		return infoById;
	}

	async deleteNotes(noteIds: string[]): Promise<void> {
		const numericNoteIds = noteIds
			.map((noteId) => parseNumericNoteId(noteId))
			.filter((noteId) => Number.isInteger(noteId));

		if (numericNoteIds.length !== noteIds.length) {
			throw new AnkiConnectError("One or more Anki note ids are invalid.");
		}

		await this.call("deleteNotes", {
			notes: numericNoteIds,
		});
	}

	async exportPackage(
		deckName: string,
		path: string,
		includeSched = true,
	): Promise<void> {
		const normalizedDeckName = deckName.trim();
		if (!normalizedDeckName) {
			throw new AnkiConnectError("Backup export deck is empty.");
		}

		const normalizedPath = path.trim();
		if (!normalizedPath) {
			throw new AnkiConnectError("Backup export path is empty.");
		}

		const result = await this.call<boolean>("exportPackage", {
			deck: normalizedDeckName,
			path: normalizedPath,
			includeSched,
		});
		if (result !== true) {
			throw new AnkiConnectError("AnkiConnect exportPackage reported failure.");
		}
	}

	private async ensureObakModel(): Promise<void> {
		const modelNames = await this.getModelNames();
		if (!modelNames.includes(OBAK_MODEL_NAME)) {
			await this.createObakModel();
			return;
		}

		const fieldNames = await this.getModelFieldNames(OBAK_MODEL_NAME);
		const sameFieldOrder =
			fieldNames.length === OBAK_MODEL_FIELDS.length &&
			fieldNames.every(
				(fieldName, index) => fieldName === OBAK_MODEL_FIELDS[index],
			);

		if (!sameFieldOrder) {
			throw new AnkiConnectError(
				`Anki model "${OBAK_MODEL_NAME}" exists but does not match the expected field schema. Delete the model and sync again.`,
			);
		}

		await this.ensureObakModelPresentation();
	}

	private async createObakModel(): Promise<void> {
		await this.call("createModel", {
			modelName: OBAK_MODEL_NAME,
			inOrderFields: [...OBAK_MODEL_FIELDS],
			cardTemplates: OBAK_CARD_TEMPLATES,
			css: OBAK_MODEL_CSS,
			isCloze: false,
		});
	}

	private async getVersion(): Promise<number> {
		return this.call<number>("version");
	}

	private async getDeckNamesAndIds(): Promise<Record<string, number>> {
		const deckNamesAndIds = await this.call<Record<string, unknown>>("deckNamesAndIds");
		if (!isRecord(deckNamesAndIds)) {
			return {};
		}

		return Object.entries(deckNamesAndIds).reduce<Record<string, number>>(
			(result, [deckName, deckId]) => {
				if (typeof deckId === "number" && Number.isInteger(deckId)) {
					result[deckName] = deckId;
				}

				return result;
			},
			{},
		);
	}

	private async getModelNames(): Promise<string[]> {
		return this.call<string[]>("modelNames");
	}

	private async getModelFieldNames(modelName: string): Promise<string[]> {
		return this.call<string[]>("modelFieldNames", { modelName });
	}

	private async getModelTemplates(
		modelName: string,
	): Promise<Record<string, ObakStoredCardTemplate>> {
		return this.call<Record<string, ObakStoredCardTemplate>>("modelTemplates", {
			modelName,
		});
	}

	private async getModelStyling(modelName: string): Promise<string> {
		const styling = await this.call<{ css?: unknown }>("modelStyling", {
			modelName,
		});

		return typeof styling.css === "string" ? styling.css : "";
	}

	private async updateModelTemplates(
		modelName: string,
		templates: Record<string, ObakStoredCardTemplate>,
	): Promise<void> {
		await this.call("updateModelTemplates", {
			model: {
				name: modelName,
				templates,
			},
		});
	}

	private async updateModelStyling(modelName: string, css: string): Promise<void> {
		await this.call("updateModelStyling", {
			model: {
				name: modelName,
				css,
			},
		});
	}

	private async deleteDecks(deckNames: string[]): Promise<void> {
		const normalizedDeckNames = [
			...new Set(deckNames.map((deckName) => deckName.trim()).filter(Boolean)),
		];
		if (normalizedDeckNames.length === 0) {
			return;
		}

		await this.call("deleteDecks", {
			decks: normalizedDeckNames,
			cardsToo: true,
		});
	}

	private async findCards(query: string): Promise<number[]> {
		return this.call<number[]>("findCards", { query });
	}

	private async ensureObakModelPresentation(): Promise<void> {
		const expectedTemplates = buildObakTemplateMap();
		const [templates, styling] = await Promise.all([
			this.getModelTemplates(OBAK_MODEL_NAME),
			this.getModelStyling(OBAK_MODEL_NAME),
		]);

		if (!sameModelTemplates(templates, expectedTemplates)) {
			await this.updateModelTemplates(OBAK_MODEL_NAME, expectedTemplates);
		}

		if (normalizeMarkupText(styling) !== normalizeMarkupText(OBAK_MODEL_CSS)) {
			await this.updateModelStyling(OBAK_MODEL_NAME, OBAK_MODEL_CSS);
		}
	}

	private async call<TResult>(
		action: string,
		params?: Record<string, unknown>,
	): Promise<TResult> {
		const response = await requestUrl({
			url: this.endpoint,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({
				action,
				version: ANKI_CONNECT_VERSION,
				params,
			}),
			headers: {
				Accept: "application/json",
			},
		});

		const payload = response.json as Partial<AnkiConnectEnvelope<TResult>>;
		if (!payload || typeof payload !== "object") {
			throw new AnkiConnectError(`AnkiConnect returned an invalid response for ${action}.`);
		}

		if (payload.error) {
			throw new AnkiConnectError(`AnkiConnect ${action} failed: ${payload.error}`);
		}

		return payload.result as TResult;
	}
}

function buildObakNotePayload(input: ObakNoteInput): {
	deckName: string;
	fields: Record<ObakModelFieldName, string>;
	modelName: string;
	tags: string[];
} {
	return {
		deckName: input.deckName,
		modelName: OBAK_MODEL_NAME,
		fields: buildObakFields(input.fields),
		tags: input.tags,
	};
}

function unwrapMultiActionResult<TResult>(value: unknown): {
	error: string | null;
	result: TResult;
} {
	if (isAnkiConnectEnvelope<TResult>(value)) {
		return {
			error: value.error,
			result: value.result,
		};
	}

	return {
		error: null,
		result: value as TResult,
	};
}

function isAnkiConnectEnvelope<TResult>(
	value: unknown,
): value is AnkiConnectEnvelope<TResult> {
	return value !== null && typeof value === "object" && "error" in value;
}

function buildObakModelQuery(): string {
	const escapedModelName = escapeAnkiSearchTerm(OBAK_MODEL_NAME);
	return `note:"${escapedModelName}"`;
}

function escapeAnkiSearchTerm(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeNumericIds(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((entry): entry is number => Number.isInteger(entry))
		.map((entry) => String(entry));
}

function parseNumericNoteId(noteId: string): number {
	const numericNoteId = Number.parseInt(noteId, 10);
	if (!Number.isInteger(numericNoteId)) {
		throw new AnkiConnectError(`Invalid Anki note id "${noteId}".`);
	}

	return numericNoteId;
}

function parseAnkiNoteInfo(value: unknown): AnkiNoteInfo | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const noteId = "noteId" in value && typeof value.noteId === "number" ? value.noteId : null;
	const modelName =
		"modelName" in value && typeof value.modelName === "string" ? value.modelName : null;
	const tags =
		"tags" in value && Array.isArray(value.tags)
			? value.tags.filter((tag): tag is string => typeof tag === "string")
			: null;
	const cards =
		"cards" in value && Array.isArray(value.cards)
			? value.cards.filter((cardId): cardId is number => Number.isInteger(cardId))
			: null;
	const fields = "fields" in value ? parseAnkiNoteFields(value.fields) : null;

	if (noteId === null || modelName === null || tags === null || cards === null || fields === null) {
		return null;
	}

	return {
		noteId: String(noteId),
		modelName,
		tags,
		cards,
		fields,
	};
}

function parseAnkiNoteFields(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	const fields: Record<string, string> = {};

	for (const [fieldName, fieldValue] of Object.entries(value)) {
		if (!isAnkiFieldValue(fieldValue)) {
			return null;
		}

		fields[fieldName] = fieldValue.value;
	}

	return fields;
}

function sameModelTemplates(
	actual: Record<string, ObakStoredCardTemplate>,
	expected: Record<string, ObakStoredCardTemplate>,
): boolean {
	for (const [name, template] of Object.entries(expected)) {
		const actualTemplate = actual[name];
		if (!actualTemplate) {
			return false;
		}

		if (
			normalizeMarkupText(actualTemplate.Front) !== normalizeMarkupText(template.Front) ||
			normalizeMarkupText(actualTemplate.Back) !== normalizeMarkupText(template.Back)
		) {
			return false;
		}
	}

	return true;
}

function normalizeMarkupText(value: string): string {
	return value.replace(/\r\n?/g, "\n").trim();
}

function isAnkiFieldValue(value: unknown): value is { value: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"value" in value &&
		typeof value.value === "string"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
