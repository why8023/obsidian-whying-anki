import { requestUrl } from "obsidian";
import type { WhyingAnkiSettings } from "./settings";

const ANKI_CONNECT_VERSION = 5;
const BASIC_MODEL_NAME = "Basic";
const BASIC_MODEL_FIELDS = ["Front", "Back"];

interface AnkiConnectEnvelope<TResult> {
	result: TResult;
	error: string | null;
}

export class AnkiConnectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnkiConnectError";
	}
}

export class AnkiClient {
	private readonly endpoint: string;

	constructor(settings: Pick<WhyingAnkiSettings, "ankiHost" | "ankiPort">) {
		this.endpoint = `http://${settings.ankiHost}:${settings.ankiPort}`;
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
		fields: { front: string; back: string },
	): Promise<void> {
		const numericNoteId = Number.parseInt(noteId, 10);
		if (!Number.isInteger(numericNoteId)) {
			throw new AnkiConnectError(`Invalid Anki note id "${noteId}".`);
		}

		await this.call("updateNoteFields", {
			note: {
				id: numericNoteId,
				fields: {
					Front: fields.front,
					Back: fields.back,
				},
			},
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
