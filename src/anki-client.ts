import { requestUrl } from "obsidian";
import type { WhyingAnkiSettings } from "./settings";

const ANKI_CONNECT_VERSION = 6;
const BASIC_MODEL_NAME = "Basic";
const BASIC_MODEL_FIELDS = ["Front", "Back"];

export interface AnkiNoteInfo {
	noteId: string;
	modelName: string;
	tags: string[];
	cards: number[];
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

	async ensureReadyForBasicSync(): Promise<void> {
		const version = await this.getVersion();
		if (version < ANKI_CONNECT_VERSION) {
			throw new AnkiConnectError(
				`AnkiConnect version ${version} is too old. Expected ${ANKI_CONNECT_VERSION}+ .`,
			);
		}

		const modelNames = await this.getModelNames();
		if (!modelNames.includes(BASIC_MODEL_NAME)) {
			throw new AnkiConnectError(
				`Anki model "${BASIC_MODEL_NAME}" is not available.`,
			);
		}

		const fieldNames = await this.getModelFieldNames(BASIC_MODEL_NAME);
		for (const fieldName of BASIC_MODEL_FIELDS) {
			if (!fieldNames.includes(fieldName)) {
				throw new AnkiConnectError(
					`Anki model "${BASIC_MODEL_NAME}" is missing field "${fieldName}".`,
				);
			}
		}
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
			if (!isAnkiConnectEnvelope(result) || !result.error) {
				return [];
			}

			return [`${normalizedDeckNames[index]}: ${result.error}`];
		});

		if (errors.length > 0) {
			throw new AnkiConnectError(`AnkiConnect createDeck failed: ${errors.join("; ")}`);
		}
	}

	async addBasicNote(input: {
		deckName: string;
		front: string;
		back: string;
		tags: string[];
	}): Promise<string> {
		const noteId = await this.call<number>("addNote", {
			note: {
				deckName: input.deckName,
				modelName: BASIC_MODEL_NAME,
				fields: {
					Front: input.front,
					Back: input.back,
				},
				tags: input.tags,
			},
		});

		return String(noteId);
	}

	async updateBasicNote(
		noteId: string,
		fields: { back: string; front: string; tags: string[] },
	): Promise<void> {
		await this.call("updateNote", {
			note: {
				id: parseNumericNoteId(noteId),
				fields: {
					Front: fields.front,
					Back: fields.back,
				},
				tags: fields.tags,
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

function isAnkiConnectEnvelope(value: unknown): value is AnkiConnectEnvelope<number> {
	return value !== null && typeof value === "object" && "error" in value;
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

	if (noteId === null || modelName === null || tags === null || cards === null) {
		return null;
	}

	return {
		noteId: String(noteId),
		modelName,
		tags,
		cards,
	};
}
