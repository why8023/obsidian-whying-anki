import { Notice } from "obsidian";
import type { ParseError, SyncProgressUpdate } from "./types";

const INDETERMINATE_PROGRESS_WIDTH = "35%";

export class SyncProgressNotice {
	private readonly notice: Notice;
	private readonly titleEl: HTMLDivElement;
	private readonly statusEl: HTMLDivElement;
	private readonly metaEl: HTMLDivElement;
	private readonly barEl: HTMLDivElement;

	constructor(title: string) {
		this.notice = new Notice("", 0);
		this.notice.messageEl.empty();

		const rootEl = document.createElement("div");
		rootEl.className = "obak-notice obak-sync-progress";

		this.titleEl = document.createElement("div");
		this.titleEl.className = "obak-notice__summary";
		this.titleEl.textContent = title;
		rootEl.append(this.titleEl);

		this.statusEl = document.createElement("div");
		this.statusEl.className = "obak-sync-progress__status";
		rootEl.append(this.statusEl);

		const trackEl = document.createElement("div");
		trackEl.className = "obak-sync-progress__track";

		this.barEl = document.createElement("div");
		this.barEl.className = "obak-sync-progress__bar";
		trackEl.append(this.barEl);
		rootEl.append(trackEl);

		this.metaEl = document.createElement("div");
		this.metaEl.className = "obak-sync-progress__meta";
		rootEl.append(this.metaEl);

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
					: "Preparing...";
			return;
		}

		const completed = Math.max(0, Math.min(progress.completed, progress.total));
		const percent = Math.round((completed / progress.total) * 100);

		this.barEl.classList.remove("is-indeterminate");
		this.barEl.style.width = `${percent}%`;
		this.metaEl.textContent = `${completed}/${progress.total} (${percent}%)`;
	}

	hide(): void {
		this.notice.hide();
	}
}

export function buildNoticeMessage(
	summary: string,
	issues: string[],
	showDetailedIssues: boolean,
): string | DocumentFragment {
	if (!showDetailedIssues || issues.length === 0) {
		return summary;
	}

	const fragment = document.createDocumentFragment();
	const rootEl = document.createElement("div");
	rootEl.className = "obak-notice";

	const summaryEl = document.createElement("div");
	summaryEl.className = "obak-notice__summary";
	summaryEl.textContent = summary;
	rootEl.append(summaryEl);

	const detailsEl = document.createElement("div");
	detailsEl.className = "obak-notice__details";

	for (const issue of issues) {
		const detailEl = document.createElement("div");
		detailEl.className = "obak-notice__detail";
		detailEl.textContent = issue;
		detailsEl.append(detailEl);
	}

	rootEl.append(detailsEl);
	fragment.append(rootEl);
	return fragment;
}

export function formatParseError(error: ParseError): string {
	return `${error.filePath}:${error.line} ${error.message}`;
}
