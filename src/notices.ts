import { Notice } from "obsidian";
import type { ParseError, SyncProgressUpdate } from "./types";

const INDETERMINATE_PROGRESS_WIDTH = "35%";
const NOTICE_SHELL_CLASS = "obak-notice-shell";
const NOTICE_MESSAGE_CLASS = "obak-notice-shell__message";

export type NoticeTone = "neutral" | "success" | "warning" | "danger";
export type NoticeMetricTone =
	| "neutral"
	| "positive"
	| "warning"
	| "danger";

export interface NoticeMetric {
	label: string;
	value: string;
	tone?: NoticeMetricTone;
}

export interface NoticeMessageOptions {
	label?: string;
	title: string;
	summary?: string;
	metrics?: NoticeMetric[];
	issues?: string[];
	showDetailedIssues?: boolean;
	tone?: NoticeTone;
}

export class SyncProgressNotice {
	private readonly notice: Notice;
	private readonly statusEl: HTMLDivElement;
	private readonly metaEl: HTMLDivElement;
	private readonly barEl: HTMLDivElement;

	constructor(title: string) {
		this.notice = createStyledNotice(0);
		this.notice.messageEl.empty();

		const rootEl = createNoticeRoot("neutral");
		rootEl.classList.add("obak-sync-progress");

		const headerEl = document.createElement("div");
		headerEl.className = "obak-notice__header obak-sync-progress__header";

		const labelEl = document.createElement("div");
		labelEl.className = "obak-notice__label";
		labelEl.textContent = "Anki sync";
		headerEl.append(labelEl);

		const titleEl = document.createElement("div");
		titleEl.className = "obak-notice__title";
		titleEl.textContent = title;
		headerEl.append(titleEl);

		this.metaEl = document.createElement("div");
		this.metaEl.className = "obak-sync-progress__meta";
		headerEl.append(this.metaEl);

		rootEl.append(headerEl);

		this.statusEl = document.createElement("div");
		this.statusEl.className = "obak-sync-progress__status";
		rootEl.append(this.statusEl);

		const trackEl = document.createElement("div");
		trackEl.className = "obak-sync-progress__track";

		this.barEl = document.createElement("div");
		this.barEl.className = "obak-sync-progress__bar";
		trackEl.append(this.barEl);
		rootEl.append(trackEl);

		this.notice.messageEl.append(rootEl);
		this.update({
			message: "Preparing sync...",
			completed: 0,
			total: null,
		});
	}

	update(progress: SyncProgressUpdate): void {
		this.statusEl.textContent = progress.message;

		if (progress.total === null || progress.total <= 0) {
			this.barEl.classList.add("is-indeterminate");
			this.barEl.style.width = INDETERMINATE_PROGRESS_WIDTH;
			this.metaEl.textContent =
				progress.completed > 0
					? `${progress.completed} step(s) completed`
					: "Waiting for the scan summary...";
			return;
		}

		const completed = Math.max(0, Math.min(progress.completed, progress.total));
		const percent = Math.round((completed / progress.total) * 100);

		this.barEl.classList.remove("is-indeterminate");
		this.barEl.style.width = `${percent}%`;
		this.metaEl.textContent = `${completed}/${progress.total} cards | ${percent}%`;
	}

	hide(): void {
		this.notice.hide();
	}
}

export function buildNoticeMessage(
	options: NoticeMessageOptions,
): DocumentFragment {
	const {
		label,
		title,
		summary,
		metrics = [],
		issues = [],
		showDetailedIssues = false,
		tone = "neutral",
	} = options;

	const fragment = document.createDocumentFragment();
	const rootEl = createNoticeRoot(tone);

	const headerEl = document.createElement("div");
	headerEl.className = "obak-notice__header";

	if (label) {
		const labelEl = document.createElement("div");
		labelEl.className = "obak-notice__label";
		labelEl.textContent = label;
		headerEl.append(labelEl);
	}

	const titleEl = document.createElement("div");
	titleEl.className = "obak-notice__title";
	titleEl.textContent = title;
	headerEl.append(titleEl);
	rootEl.append(headerEl);

	if (summary) {
		const summaryEl = document.createElement("div");
		summaryEl.className = "obak-notice__summary";
		summaryEl.textContent = summary;
		rootEl.append(summaryEl);
	}

	if (metrics.length > 0) {
		const metricsEl = document.createElement("div");
		metricsEl.className = "obak-notice__metrics";

		for (const metric of metrics) {
			const metricEl = document.createElement("span");
			metricEl.className = `obak-notice__metric obak-notice__metric--${metric.tone ?? "neutral"}`;

			const labelEl = document.createElement("span");
			labelEl.className = "obak-notice__metric-label";
			labelEl.textContent = metric.label;
			metricEl.append(labelEl);

			const valueEl = document.createElement("span");
			valueEl.className = "obak-notice__metric-value";
			valueEl.textContent = metric.value;
			metricEl.append(valueEl);

			metricsEl.append(metricEl);
		}

		rootEl.append(metricsEl);
	}

	if (issues.length > 0) {
		if (showDetailedIssues) {
			const detailsTitleEl = document.createElement("div");
			detailsTitleEl.className = "obak-notice__details-title";
			detailsTitleEl.textContent = `${issues.length} issue(s)`;
			rootEl.append(detailsTitleEl);

			const detailsEl = document.createElement("div");
			detailsEl.className = "obak-notice__details";

			for (const issue of issues) {
				const detailEl = document.createElement("div");
				detailEl.className = "obak-notice__detail";
				detailEl.textContent = issue;
				detailsEl.append(detailEl);
			}

			rootEl.append(detailsEl);
		} else {
			const hintEl = document.createElement("div");
			hintEl.className = "obak-notice__hint";
			hintEl.textContent =
				"Detailed issues are hidden in notices. Check the console or enable detailed notices in settings.";
			rootEl.append(hintEl);
		}
	}

	fragment.append(rootEl);
	return fragment;
}

export function formatParseError(error: ParseError): string {
	return `${error.filePath}:${error.line} ${error.message}`;
}

export function showStyledNotice(
	message: string | DocumentFragment,
	duration?: number,
): Notice {
	const notice = createStyledNotice(duration);
	notice.setMessage(message);
	return notice;
}

function createNoticeRoot(tone: NoticeTone): HTMLDivElement {
	const rootEl = document.createElement("div");
	rootEl.className = `obak-notice obak-notice--${tone}`;
	return rootEl;
}

function createStyledNotice(duration?: number): Notice {
	const notice = new Notice("", duration);
	attachNoticeClasses(notice);
	return notice;
}

function attachNoticeClasses(notice: Notice): void {
	notice.containerEl?.classList.add(NOTICE_SHELL_CLASS);
	notice.messageEl.parentElement?.classList.add(NOTICE_SHELL_CLASS);
	notice.messageEl.classList.add(NOTICE_MESSAGE_CLASS);
}
