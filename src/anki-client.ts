import { requestUrl } from "obsidian";
import {
	OBAK_CARD_TEMPLATES,
	OBAK_MODEL_CSS,
	OBAK_MODEL_FIELDS,
	OBAK_MODEL_NAME,
	buildObakTemplateMap,
	buildObakFields,
	type ObakModelFieldName,
	type ObakNoteInput,
	type ObakStoredCardTemplate,
} from "./anki-model";
import type { ObakSettings } from "./settings";

const ANKI_CONNECT_VERSION = 6;

/**
 * `notesInfo` 接口中插件真正依赖的字段集合。
 */
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

/**
 * 统一封装 AnkiConnect 返回错误。
 */
export class AnkiConnectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnkiConnectError";
	}
}

/**
 * AnkiConnect API 客户端。
 * 负责连接检查、模型校验、牌组准备以及笔记增删改查。
 */
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

	/**
	 * 同步前的准备工作：
	 * 1. 校验 AnkiConnect 版本
	 * 2. 确保 OBAK 模型存在且结构正确
	 */
	async ensureReadyForSync(): Promise<void> {
		const version = await this.getVersion();
		if (version < ANKI_CONNECT_VERSION) {
			throw new AnkiConnectError(
				`AnkiConnect version ${version} is too old. Expected ${ANKI_CONNECT_VERSION}+ .`,
			);
		}

		await this.ensureObakModel();
	}

	/**
	 * 按需创建缺失牌组。
	 * 这里使用 `multi` 批量发送，减少请求往返。
	 */
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

	/**
	 * 新建一条 Obak 笔记，返回创建后的 noteId。
	 */
	async addObakNote(input: ObakNoteInput): Promise<string> {
		const noteId = await this.call<number>("addNote", {
			note: buildObakNotePayload(input),
		});

		return String(noteId);
	}

	/**
	 * 预检查一组笔记是否允许创建。
	 * 主要用来提前发现重复 UID 等问题。
	 */
	async canAddObakNotes(inputs: ObakNoteInput[]): Promise<boolean[]> {
		if (inputs.length === 0) {
			return [];
		}

		return this.call<boolean[]>("canAddNotes", {
			notes: inputs.map((input) => buildObakNotePayload(input)),
		});
	}

	/**
	 * 更新已存在笔记的字段和标签。
	 */
	async updateObakNote(noteId: string, input: ObakNoteInput): Promise<void> {
		await this.call("updateNote", {
			note: {
				id: parseNumericNoteId(noteId),
				fields: buildObakFields(input.fields),
				tags: input.tags,
			},
		});
	}

	/**
	 * 把一条笔记对应的全部卡片移到新的牌组。
	 * Anki 的换 deck 操作作用在 cardId 上，而不是 noteId。
	 */
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

	/**
	 * 根据 ObsidianUid 查询匹配的 noteId 列表。
	 * 理论上每个 UID 只应命中一条笔记。
	 */
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

	/**
	 * 批量获取指定 noteId 的详情。
	 */
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

	/**
	 * 删除一组笔记。
	 */
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
		// 先确认模型存在；存在时再严格校验字段顺序是否与插件预期一致。
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
		// 首次同步时自动创建模型，减少用户手动准备成本。
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

	private async ensureObakModelPresentation(): Promise<void> {
		const expectedTemplates = buildObakTemplateMap();
		const [templates, styling] = await Promise.all([
			this.getModelTemplates(OBAK_MODEL_NAME),
			this.getModelStyling(OBAK_MODEL_NAME),
		]);

		// 字段结构不兼容时直接报错；模板和 CSS 则允许自动更新。
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
		// 所有 AnkiConnect 请求统一从这里发出，便于集中处理协议版本和错误包装。
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
	// `multi` 的返回值既可能是 envelope，也可能是裸 result；这里统一规整。
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
	// 先限定模型，再限定字段值，避免误命中其他模型的同名字段。
	const escapedModelName = escapeAnkiSearchTerm(OBAK_MODEL_NAME);
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
	// AnkiConnect 返回的是动态 JSON，这里做严格解析，防止脏数据进入同步流程。
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
	// 比较时忽略换行差异和首尾空白，只关心模板内容是否等价。
	for (const [name, template] of Object.entries(expected)) {
		const actualTemplate = actual[name];
		if (!actualTemplate) {
			return false;
		}

		if (
			normalizeMarkupText(actualTemplate.Front) !==
				normalizeMarkupText(template.Front) ||
			normalizeMarkupText(actualTemplate.Back) !==
				normalizeMarkupText(template.Back)
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
