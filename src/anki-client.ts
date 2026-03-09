import { requestUrl } from "obsidian";
import {
	WHYING_ANKI_CARD_TEMPLATES,
	WHYING_ANKI_MODEL_CSS,
	WHYING_ANKI_MODEL_FIELDS,
	WHYING_ANKI_MODEL_NAME,
	buildWhyingAnkiFields,
	type WhyingAnkiModelFieldName,
	type WhyingAnkiNoteInput,
} from "./anki-model";
import type { WhyingAnkiSettings } from "./settings";

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
			WhyingAnkiSettings,
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

		await this.ensureWhyingModel();
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

		const results = await this.call<Array<AnkiConnectEnvelope<number> | number>>("multi", {
			actions: normalizedDeckNames.map<AnkiConnectMultiAction>((deckName) => ({
				action: "createDeck",
				version: ANKI_CONNECT_VERSION,
				params: { deck: deckName },
			})),
		});

		const errors = results.flatMap((result, index) => {
			const unwrappedResult = unwrapMultiActionResult<number>(result);
			if (!unwrappedResult.error) {
				return [];
			}

			return [`${normalizedDeckNames[index]}: ${unwrappedResult.error}`];
		});

		if (errors.length > 0) {
			throw new AnkiConnectError(`AnkiConnect createDeck failed: ${errors.join("; ")}`);
		}
	}

	async addWhyingNote(input: WhyingAnkiNoteInput): Promise<string> {
		const noteId = await this.call<number>("addNote", {
			note: buildWhyingNotePayload(input),
		});

		return String(noteId);
	}

	async canAddWhyingNotes(inputs: WhyingAnkiNoteInput[]): Promise<boolean[]> {
		if (inputs.length === 0) {
			return [];
		}

		return this.call<boolean[]>("canAddNotes", {
			notes: inputs.map((input) => buildWhyingNotePayload(input)),
		});
	}

	async updateWhyingNote(noteId: string, input: WhyingAnkiNoteInput): Promise<void> {
		await this.call("updateNote", {
			note: {
				id: parseNumericNoteId(noteId),
				fields: buildWhyingAnkiFields(input.fields),
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

	async findNotesByObsidianUid(
		uids: string[],
	): Promise<Map<string, string[]>> {
		const normalizedUids = [...new Set(uids.map((uid) => uid.trim()).filter(Boolean))];
		if (normalizedUids.length === 0) {
			return new Map();
		}

		const results = await this.call<Array<AnkiConnectEnvelope<number[]> | number[]>>("multi", {
			actions: normalizedUids.map<AnkiConnectMultiAction>((uid) => ({
				action: "findNotes",
				version: ANKI_CONNECT_VERSION,
				params: {
					query: buildObsidianUidQuery(uid),
				},
			})),
		});

		const noteIdsByUid = new Map<string, string[]>();

		results.forEach((result, index) => {
			const uid = normalizedUids[index];
			if (!uid) {
				return;
			}

			const unwrappedResult = unwrapMultiActionResult<number[]>(result);
			if (unwrappedResult.error) {
				throw new AnkiConnectError(
					`AnkiConnect findNotes failed for ObsidianUid "${uid}": ${unwrappedResult.error}`,
				);
			}

			noteIdsByUid.set(uid, normalizeNumericIds(unwrappedResult.result));
		});

		return noteIdsByUid;
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

	private async ensureWhyingModel(): Promise<void> {
		const modelNames = await this.getModelNames();
		if (!modelNames.includes(WHYING_ANKI_MODEL_NAME)) {
			await this.createWhyingModel();
			return;
		}

		const fieldNames = await this.getModelFieldNames(WHYING_ANKI_MODEL_NAME);
		const sameFieldOrder =
			fieldNames.length === WHYING_ANKI_MODEL_FIELDS.length &&
			fieldNames.every(
				(fieldName, index) => fieldName === WHYING_ANKI_MODEL_FIELDS[index],
			);

		if (!sameFieldOrder) {
			throw new AnkiConnectError(
				`Anki model "${WHYING_ANKI_MODEL_NAME}" exists but does not match the expected field schema. Delete the model and sync again.`,
			);
		}
	}

	private async createWhyingModel(): Promise<void> {
		await this.call("createModel", {
			modelName: WHYING_ANKI_MODEL_NAME,
			inOrderFields: [...WHYING_ANKI_MODEL_FIELDS],
			cardTemplates: WHYING_ANKI_CARD_TEMPLATES,
			css: WHYING_ANKI_MODEL_CSS,
			isCloze: false,
		});
	}

	private async getVersion(): Promise<number> {
		return this.call<number>("version");
	}

	private async getModelNames(): Promise<string[]> {
		return this.call<string[]>("modelNames");
	}

	private async getModelFieldNames(modelName: string): Promise<string[]> {
		return this.call<string[]>("modelFieldNames", { modelName });
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

function buildWhyingNotePayload(input: WhyingAnkiNoteInput): {
	deckName: string;
	fields: Record<WhyingAnkiModelFieldName, string>;
	modelName: string;
	tags: string[];
} {
	return {
		deckName: input.deckName,
		modelName: WHYING_ANKI_MODEL_NAME,
		fields: buildWhyingAnkiFields(input.fields),
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

function buildObsidianUidQuery(uid: string): string {
	const escapedModelName = escapeAnkiSearchTerm(WHYING_ANKI_MODEL_NAME);
	const escapedUid = escapeAnkiSearchTerm(uid);
	return `note:"${escapedModelName}" ObsidianUid:"${escapedUid}"`;
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
	const fields =
		"fields" in value ? parseAnkiNoteFields(value.fields) : null;

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
		if (
			!fieldValue ||
			typeof fieldValue !== "object" ||
			!("value" in fieldValue) ||
			typeof fieldValue.value !== "string"
		) {
			return null;
		}

		fields[fieldName] = fieldValue.value;
	}

	return fields;
}
